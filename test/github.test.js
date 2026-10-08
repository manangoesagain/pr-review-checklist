import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReader, GITHUB_API, parsePrLink } from '../lib/github.js';
import { loadSample, ReviewError, runReview } from '../lib/review.js';

const DEMO = 'https://github.com/manangoesagain/bookshop-demo/pull/1';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A stand-in for GitHub that answers from a saved sample and records every request. */
function fakeGitHub(sample = loadSample('demo'), overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const { pathname, searchParams } = new URL(url);
    const route = pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (overrides[route]) return overrides[route](searchParams);
    if (route === `/pulls/${sample.pr.number}`) return json(sample.pr);
    if (route === `/pulls/${sample.pr.number}/files`) {
      const page = Number(searchParams.get('page'));
      return json(sample.files.slice((page - 1) * 100, page * 100));
    }
    if (route === '/readme') return sample.readme ? new Response(sample.readme) : json({ message: 'Not Found' }, 404);
    return json({ message: 'Not Found' }, 404);
  };
  return { calls, fetchImpl };
}

test('PR links parse with or without the extras people copy', () => {
  const expected = { owner: 'manangoesagain', repo: 'bookshop-demo', number: 1, key: 'manangoesagain/bookshop-demo#1' };
  for (const link of [
    DEMO,
    `${DEMO}/`,
    `${DEMO}/files`,
    `${DEMO}/files#diff-4f2a`,
    `${DEMO}#discussion_r123`,
    `${DEMO}?w=1`,
    `${DEMO}/commits/f5f5de1`,
    '  github.com/manangoesagain/bookshop-demo/pull/1  ',
    'http://www.github.com/manangoesagain/bookshop-demo/pull/1',
    'https://github.com/manangoesagain/bookshop-demo.git/pull/1',
  ]) {
    assert.deepEqual(parsePrLink(link), expected, link);
  }
  assert.equal(parsePrLink('https://github.com/Owner/Repo/pull/7').key, 'owner/repo#7');
});

test('anything that isn\'t a GitHub PR link gets the plain message', () => {
  for (const link of [
    '',
    'hello',
    'https://gitlab.com/a/b/-/merge_requests/1',
    'https://github.com/a/b/issues/1',
    'https://github.com/a/b/pull/abc',
    'https://github.com/a/b/pull/0',
    'https://github.com/a/b',
    'https://github.com.evil.example/a/b/pull/1',
    'https://github.com:8443/a/b/pull/1',
    'https://github.com/-a/b/pull/1',
    'https://github.com/a/../pull/1',
    'javascript:alert(1)//github.com/a/b/pull/1',
    'ftp://github.com/a/b/pull/1',
  ]) {
    assert.throws(() => parsePrLink(link), { code: 'not-a-pr', message: /should end in \/pull\/ and a number/ }, link);
  }
});

test('reading a PR: details, changed files, then the README at the PR\'s commit', async () => {
  const github = fakeGitHub();
  const data = await createGitHubReader({ fetchImpl: github.fetchImpl }).readPr(parsePrLink(DEMO));
  assert.deepEqual(github.calls.map((c) => c.url), [
    `${GITHUB_API}/repos/manangoesagain/bookshop-demo/pulls/1`,
    `${GITHUB_API}/repos/manangoesagain/bookshop-demo/pulls/1/files?per_page=100&page=1`,
    `${GITHUB_API}/repos/manangoesagain/bookshop-demo/readme?ref=f5f5de12d78c511a34c1c34c099a2aa27225d90f`,
  ]);
  const [pr, , readme] = github.calls;
  assert.equal(pr.headers['user-agent'], 'pr-review-checklist');
  assert.equal(pr.headers['x-github-api-version'], '2022-11-28');
  assert.equal(pr.headers.authorization, undefined, 'no token, no header');
  assert.equal(readme.headers.accept, 'application/vnd.github.raw+json');
  assert.equal(data.pr.title, 'Add order search');
  assert.equal(data.files.length, 4);
  assert.match(data.readme, /^# Bookshop API/);
  assert.equal(data.fromCache, false);
});

test('a GITHUB_TOKEN is sent as a Bearer header', async () => {
  const github = fakeGitHub();
  await createGitHubReader({ token: 'ghp_test', fetchImpl: github.fetchImpl }).readPr(parsePrLink(DEMO));
  assert.ok(github.calls.every((c) => c.headers.authorization === 'Bearer ghp_test'));
});

test('big PRs are read page by page, 100 files at a time', async () => {
  const sample = loadSample('demo');
  const one = sample.files[2];
  sample.files = Array.from({ length: 250 }, (_, i) => ({ ...one, filename: `src/file${i}.ts` }));
  sample.pr.changed_files = 250;
  const github = fakeGitHub(sample);
  const data = await createGitHubReader({ fetchImpl: github.fetchImpl }).readPr(parsePrLink(DEMO));
  assert.equal(data.files.length, 250);
  assert.deepEqual(github.calls.filter((c) => c.url.includes('/files')).map((c) => new URL(c.url).searchParams.get('page')), ['1', '2', '3']);
});

test('the same link within 10 minutes makes no new calls; after that it reads again', async () => {
  let now = 1_000_000;
  const github = fakeGitHub();
  const reader = createGitHubReader({ fetchImpl: github.fetchImpl, clock: () => now });
  await reader.readPr(parsePrLink(DEMO));
  now += 9 * 60_000;
  const again = await reader.readPr(parsePrLink(`${DEMO}/files`));
  assert.equal(github.calls.length, 3);
  assert.equal(again.fromCache, true);
  assert.equal(again.pr.title, 'Add order search');
  again.files.length = 0; // Changing a cached copy must not change the cache.
  assert.equal((await reader.readPr(parsePrLink(DEMO))).files.length, 4);
  now += 2 * 60_000;
  const fresh = await reader.readPr(parsePrLink(DEMO));
  assert.equal(fresh.fromCache, false);
  assert.equal(github.calls.length, 6);
});

test('GitHub problems become the PRD\'s plain messages', async () => {
  const link = parsePrLink(DEMO);
  const read = (response, options = {}) => createGitHubReader({ fetchImpl: async () => response(), ...options }).readPr(link);

  await assert.rejects(read(() => json({ message: 'Not Found' }, 404)), {
    code: 'pr-not-found', message: 'Couldn\'t open that PR. If the repo is private, paste the diff instead.',
  });

  const reset = Math.floor(new Date(2026, 9, 7, 15, 42).getTime() / 1000);
  const limited = () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  const time = new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  await assert.rejects(read(limited), (error) => {
    assert.equal(error.code, 'rate-limit');
    assert.equal(error.message, `GitHub's free limit is used up until ${time}. Add a GITHUB_TOKEN to your .env file, or paste the diff.`);
    assert.equal(error.extra.resetAt, reset);
    return true;
  });
  await assert.rejects(read(limited, { token: 't' }), { code: 'rate-limit', message: /limit for your GITHUB_TOKEN is used up until/ });
  await assert.rejects(read(() => json({}, 429, { 'retry-after': '60' })), { code: 'rate-limit' });

  await assert.rejects(read(() => json({}, 401), { token: 'bad' }), { code: 'github-token', message: /refused your GITHUB_TOKEN/ });
  await assert.rejects(read(() => json({}, 401)), { code: 'github', message: /error \(401\)/ });
  await assert.rejects(read(() => json({}, 502)), { code: 'github-down' });
  await assert.rejects(read(() => new Response('<html>', { status: 200 })), { code: 'github', message: /couldn't read/ });

  const offline = createGitHubReader({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.readPr(link), { code: 'network', message: 'Couldn\'t reach GitHub. Check your internet connection, or paste the diff.' });
});

test('GitHub not answering in time is a network problem, but Cancel stays a cancel', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
  });
  await assert.rejects(createGitHubReader({ fetchImpl: hang, timeoutMs: 20 }).readPr(parsePrLink(DEMO)), { code: 'network', message: /didn't answer within 0 seconds|didn't answer within/ });
  const controller = new AbortController();
  const pending = createGitHubReader({ fetchImpl: hang }).readPr(parsePrLink(DEMO), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a missing README isn\'t an error: the review goes on without it', async () => {
  const sample = loadSample('demo');
  sample.readme = '';
  const data = await createGitHubReader({ fetchImpl: fakeGitHub(sample).fetchImpl }).readPr(parsePrLink(DEMO));
  assert.equal(data.readme, '');
});

test('requests only ever go to api.github.com, built from the parsed parts', async () => {
  const github = fakeGitHub(loadSample('demo'), { '/pulls/1': () => json({ ...loadSample('demo').pr, changed_files: 4 }) });
  const reader = createGitHubReader({ fetchImpl: github.fetchImpl });
  await reader.readPr(parsePrLink('https://user:pass@github.com/manangoesagain/bookshop-demo/pull/1?redirect=https://evil.example'));
  assert.ok(github.calls.length > 0);
  for (const { url } of github.calls) assert.ok(url.startsWith('https://api.github.com/repos/manangoesagain/bookshop-demo/'), url);
});

test('a review by link: fetch step, GitHub links on the right commit, skipped files listed', async () => {
  const sample = loadSample('demo');
  sample.files.push({ filename: 'assets/huge.sql', status: 'added', additions: 90000, deletions: 0, changes: 90000 });
  sample.pr.changed_files = 5;
  const github = createGitHubReader({ fetchImpl: fakeGitHub(sample).fetchImpl });
  const steps = [];
  const review = await runReview({ url: `${DEMO}/files` }, { github, onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, ['fetch', 'facts']);
  assert.equal(review.source, 'github');
  assert.equal(review.pr.url, DEMO);
  const sql = review.areas.find((a) => a.id === 'security').items[0];
  assert.equal(sql.link, `https://github.com/manangoesagain/bookshop-demo/blob/${sample.pr.head.sha}/src/search.ts#L15`);
  assert.deepEqual(review.checked.skipped.map((s) => s.path), ['assets/huge.sql']);
  assert.match(review.checked.skipped[0].reason, /GitHub/);
  assert.ok(!review.notes.some((n) => /reused/.test(n)));

  const again = await runReview({ url: DEMO }, { github });
  assert.ok(again.notes.some((n) => /read from GitHub less than a minute ago and reused/.test(n)));
});

test('more files than GitHub lists are named in a note', async () => {
  const sample = loadSample('demo');
  sample.pr.changed_files = 3500;
  const review = await runReview({ url: DEMO }, { github: createGitHubReader({ fetchImpl: fakeGitHub(sample).fetchImpl }) });
  assert.ok(review.notes.some((n) => n === 'This PR changes 3500 files, but GitHub only lists the first 4, so the rest weren\'t reviewed.'));
});

test('link errors reach the page as review errors, before any GitHub call', async () => {
  const github = fakeGitHub();
  const steps = [];
  await assert.rejects(runReview({ url: 'https://github.com/a/b/issues/3' }, { github: createGitHubReader({ fetchImpl: github.fetchImpl }), onStep: (s) => steps.push(s) }),
    (error) => error instanceof ReviewError && error.code === 'not-a-pr');
  assert.deepEqual(steps, []);
  assert.equal(github.calls.length, 0);
  await assert.rejects(runReview({ url: '  ' }), { code: 'empty' });
  const missing = createGitHubReader({ fetchImpl: async () => json({ message: 'Not Found' }, 404) });
  await assert.rejects(runReview({ url: DEMO }, { github: missing }), (error) => error instanceof ReviewError && error.code === 'pr-not-found');
});

test('a PR with no changed files says so plainly', async () => {
  const sample = loadSample('demo');
  sample.files = [];
  sample.pr.changed_files = 0;
  await assert.rejects(runReview({ url: DEMO }, { github: createGitHubReader({ fetchImpl: fakeGitHub(sample).fetchImpl }) }),
    { code: 'nothing-to-review', message: 'Nothing to review: this PR has no changed files.' });
});

test('a README that fails to load doesn\'t stop the review, and isn\'t kept in the cache', async () => {
  let readmeCalls = 0;
  const failing = fakeGitHub(loadSample('demo'), {
    '/readme': () => {
      readmeCalls++;
      if (readmeCalls === 1) throw new TypeError('fetch failed');
      return new Response('# Bookshop API');
    },
  });
  const reader = createGitHubReader({ fetchImpl: failing.fetchImpl });
  const first = await reader.readPr(parsePrLink(DEMO));
  assert.equal(first.readme, '');
  const second = await reader.readPr(parsePrLink(DEMO));
  assert.equal(second.fromCache, false);
  assert.equal(second.readme, '# Bookshop API');
  const third = await reader.readPr(parsePrLink(DEMO));
  assert.equal(third.fromCache, true);
});
