// Reads a public pull request from GitHub: the PR details, its changed files and
// the README at the PR's commit. Three kinds of call, a 10-minute cache, and
// plain messages for the things that go wrong. It never fetches the link the
// person typed; it only builds api.github.com URLs from the parsed parts.

export const GITHUB_API = 'https://api.github.com';
export const CACHE_MINUTES = 10;
const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
const MAX_PAGES = 30; // GitHub lists at most 3,000 files for a PR.
const MAX_CACHED = 50;
const README_LIMIT = 100_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;

export class GitHubError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.extra = extra;
  }
}

const NOT_A_PR = 'That doesn\'t look like a pull request link. It should end in /pull/ and a number.';

/**
 * "https://github.com/owner/repo/pull/12/files#diff-1" → { owner, repo, number, key }.
 * Accepts no "https://", "www.", /files, /commits, ?w=1, #… and a trailing slash.
 */
export function parsePrLink(text) {
  let value = String(text ?? '').trim();
  if (!/^[a-z]+:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubError('not-a-pr', NOT_A_PR);
  }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || (host !== 'github.com' && host !== 'www.github.com') || url.port) {
    throw new GitHubError('not-a-pr', NOT_A_PR);
  }
  const [owner, repo, kind, number] = url.pathname.split('/').filter(Boolean);
  if (!OWNER.test(owner ?? '') || !REPO.test(repo ?? '') || repo === '.' || repo === '..' || kind !== 'pull' || !NUMBER.test(number ?? '')) {
    throw new GitHubError('not-a-pr', NOT_A_PR);
  }
  const cleanRepo = repo.replace(/\.git$/i, '');
  return { owner, repo: cleanRepo, number: Number(number), key: `${owner}/${cleanRepo}#${number}`.toLowerCase() };
}

function clockTime(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function rateLimitError(response, hasToken) {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const retryAfter = Number(response.headers.get('retry-after'));
  const resetAt = reset > 0 ? reset : retryAfter > 0 ? Math.ceil(Date.now() / 1000) + retryAfter : null;
  const until = resetAt ? `until ${clockTime(resetAt)}` : 'for now';
  const message = hasToken
    ? `GitHub's limit for your GITHUB_TOKEN is used up ${until}. Paste the diff instead, or try again then.`
    : `GitHub's free limit is used up ${until}. Add a GITHUB_TOKEN to your .env file, or paste the diff.`;
  return new GitHubError('rate-limit', message, { resetAt });
}

function isRateLimited(response) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
}

/**
 * A GitHub reader with its own cache. `fetchImpl` and `clock` let tests stand in
 * for the network and the time.
 */
export function createGitHubReader({ token = '', fetchImpl = fetch, clock = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const cache = new Map();

  async function call(pathName, { accept = 'application/vnd.github+json', signal } = {}) {
    const headers = {
      accept,
      'user-agent': 'pr-review-checklist',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(`${GITHUB_API}${pathName}`, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error; // The person pressed Cancel.
      if (timeout.aborted) throw new GitHubError('network', `GitHub didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again, or paste the diff.`);
      throw new GitHubError('network', 'Couldn\'t reach GitHub. Check your internet connection, or paste the diff.');
    }
  }

  function failure(response) {
    if (isRateLimited(response)) return rateLimitError(response, Boolean(token));
    if (response.status === 401 && token) {
      return new GitHubError('github-token', 'GitHub refused your GITHUB_TOKEN. Check the one in your .env file, or remove it to use the free limit.');
    }
    if (response.status === 404 || response.status === 403 || response.status === 451) {
      return new GitHubError('pr-not-found', 'Couldn\'t open that PR. If the repo is private, paste the diff instead.');
    }
    if (response.status >= 500) return new GitHubError('github-down', 'GitHub had a problem answering. Try again in a minute, or paste the diff.');
    return new GitHubError('github', `GitHub answered with an error (${response.status}). Try again, or paste the diff.`);
  }

  async function json(pathName, signal) {
    const response = await call(pathName, { signal });
    if (!response.ok) throw failure(response);
    try {
      return await response.json();
    } catch {
      throw new GitHubError('github', 'GitHub sent an answer we couldn\'t read. Try again, or paste the diff.');
    }
  }

  // The README isn't required: if it's missing or can't be read, the review goes on without it.
  async function readme(base, sha, signal) {
    const ref = sha ? `?ref=${encodeURIComponent(sha)}` : '';
    const response = await call(`${base}/readme${ref}`, { accept: 'application/vnd.github.raw+json', signal });
    if (!response.ok) {
      if (isRateLimited(response)) throw rateLimitError(response, Boolean(token));
      return '';
    }
    const text = await response.text().catch(() => '');
    return text.slice(0, README_LIMIT);
  }

  /** Returns { pr, files, readme, fetchedAt, fromCache } in GitHub's own shapes. */
  async function readPr(link, { signal } = {}) {
    const saved = cache.get(link.key);
    if (saved && clock() - saved.fetchedAt < CACHE_MINUTES * 60_000) {
      return { ...structuredClone(saved.data), fetchedAt: saved.fetchedAt, fromCache: true };
    }

    const base = `/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}`;
    const pr = await json(`${base}/pulls/${link.number}`, signal);
    const files = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await json(`${base}/pulls/${link.number}/files?per_page=${PER_PAGE}&page=${page}`, signal);
      if (!Array.isArray(batch)) throw new GitHubError('github', 'GitHub sent an answer we couldn\'t read. Try again, or paste the diff.');
      files.push(...batch);
      if (batch.length < PER_PAGE || files.length >= (pr.changed_files ?? Infinity)) break;
    }
    const data = { pr, files, readme: await readme(base, pr.head?.sha, signal) };

    const fetchedAt = clock();
    cache.delete(link.key); // Re-adding moves it to the end, so the oldest entry is always first.
    cache.set(link.key, { data: structuredClone(data), fetchedAt });
    // Keep the cache small: drop expired entries, then the oldest.
    for (const [key, entry] of cache) {
      if (cache.size <= MAX_CACHED && fetchedAt - entry.fetchedAt < CACHE_MINUTES * 60_000) break;
      cache.delete(key);
    }
    return { ...data, fetchedAt, fromCache: false };
  }

  return { readPr };
}
