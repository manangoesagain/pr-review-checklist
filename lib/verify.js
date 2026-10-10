// Proof for every item that points at a line: the code snippet around it and a
// GitHub link pinned to the PR's commit, so the link never drifts. The line check
// for AI items lives here too.

import { findLine } from './diff.js';

const SAFE_REPO = /^[\w.-]+\/[\w.-]+$/;
const SAFE_SHA = /^[0-9a-f]{7,40}$/i;

/** The flagged line with up to `radius` lines either side from the same hunk. */
export function snippetFor(file, side, number, radius = 2) {
  const found = findLine(file, side, number);
  if (!found) return null;
  const index = found.hunk.lines.indexOf(found.line);
  return found.hunk.lines.slice(Math.max(0, index - radius), index + radius + 1).map((line) => ({
    line: line.type === 'del' ? line.old : line.new,
    type: line.type,
    text: line.text,
    hit: line === found.line,
  }));
}

/** Link to the line on GitHub: the PR's latest commit for new lines, the base commit for removed lines. */
export function githubLink(diff, file, side, number) {
  if (diff.source !== 'github' || !SAFE_REPO.test(diff.repo ?? '')) return null;
  const sha = side === 'L' ? diff.baseSha : diff.headSha;
  if (!SAFE_SHA.test(sha ?? '')) return null;
  const filePath = side === 'L' ? file.oldPath ?? file.path : file.path;
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${diff.repo}/blob/${sha}/${encoded}#L${number}`;
}

/** Adds the snippet and link to an item that has a file and line. */
export function attachProof(item, diff) {
  if (!item.file || !item.line) return item;
  const file = diff.files.find((f) => f.path === item.file);
  if (!file) return item;
  item.snippet = snippetFor(file, item.side, item.line);
  item.link = githubLink(diff, file, item.side, item.line);
  return item;
}

/* ---------- The line check ---------- */

const AREA_WORDS = [
  ['security', /secur|inject|xss|auth|secret|vuln/i],
  ['tests', /test|coverage|spec/i],
  ['breaking', /break|compat|api.?change|contract/i],
  ['docs', /doc|readme|comment/i],
  ['performance', /perf|speed|slow|n\s*\+\s*1|query.?count|efficien/i],
];
const SEVERITY_WORDS = [
  ['must-fix', /must|critical|high|blocker|severe|error|bug/i],
  ['good-to-know', /good|know|low|info|minor|nit|tip|suggest/i],
  ['worth-asking', /worth|ask|medium|question|warn/i],
];
const COPIED_PREFIX = /^\s*[RL]\d+\s*\|[+\- ]?/;
const SNAP_DISTANCE = 3;

export const HIDE_REASONS = {
  area: 'it didn\'t name one of the five areas',
  file: 'its file isn\'t in this PR',
  unmatched: 'it couldn\'t be matched to the code',
  ambiguous: 'the code it quotes appears on several lines',
  incomplete: 'the AI\'s answer was incomplete',
};

export function normalizeArea(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const exact = AREA_WORDS.find(([id]) => id === text);
  if (exact) return exact[0];
  return AREA_WORDS.find(([, words]) => words.test(text))?.[0] ?? null;
}

export function normalizeSeverity(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (['must-fix', 'worth-asking', 'good-to-know'].includes(text)) return text;
  return SEVERITY_WORDS.find(([, words]) => words.test(text))?.[0] ?? 'worth-asking';
}

/** "R15", "r 15", "L41", "15", "line 15", "R15-R17" → { side, number } or null. */
export function parseRef(ref) {
  const match = /([RL])?\s*(?:line\s*)?(\d+)/i.exec(String(ref ?? ''));
  if (!match) return null;
  return { side: (match[1] ?? 'R').toUpperCase(), number: Number(match[2]) };
}

// Compares code the way a person would: ignoring a copied "R15 |+" prefix and extra spaces.
export function normalizeCode(text) {
  return String(text ?? '').replace(COPIED_PREFIX, '').trim().replace(/\s+/g, ' ');
}

export function evidenceMatches(evidence, lineText) {
  const quote = normalizeCode(evidence);
  const code = normalizeCode(lineText);
  if (!quote || !code) return false;
  if (quote === code) return true;
  // A quoted part of the line counts, if it has enough letters or digits to mean something.
  if ((quote.match(/[A-Za-z0-9]/g) ?? []).length >= 3 && code.includes(quote)) return true;
  // The whole line inside a longer quote counts only for lines long enough to be distinctive.
  return code.length >= 12 && quote.includes(code);
}

function findFile(diff, name) {
  const wanted = String(name ?? '').trim().replace(/^(\.\/|[ab]\/)/, '');
  const exact = diff.files.find((f) => f.path === wanted || f.oldPath === wanted);
  if (exact) return exact;
  const tails = diff.files.filter((f) => f.path.endsWith(`/${wanted}`) || wanted.endsWith(`/${f.path}`));
  return tails.length === 1 ? tails[0] : null;
}

function located(line) {
  return line.type === 'del' ? { side: 'L', number: line.old } : { side: 'R', number: line.new };
}

// Finds where an AI item really points. Returns { side, number, moved } or { reason }.
function locate(file, ref, evidence) {
  const target = ref ? findLine(file, ref.side, ref.number) : null;
  if (target && evidenceMatches(evidence, target.line.text)) {
    return { ...located(target.line), moved: false };
  }
  if (target) {
    // Off by a line or two: look nearby in the same hunk, nearest first.
    const lines = target.hunk.lines;
    const index = lines.indexOf(target.line);
    for (let distance = 1; distance <= SNAP_DISTANCE + 1; distance++) {
      for (const candidate of [lines[index - distance], lines[index + distance]]) {
        if (candidate && evidenceMatches(evidence, candidate.text)) return { ...located(candidate), moved: true };
      }
    }
  }
  // Far off, or a line that isn't in the diff: the quote must appear exactly once in the file's changes.
  const matches = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => evidenceMatches(evidence, line.text));
  if (matches.length === 1) return { ...located(matches[0]), moved: true };
  return { reason: matches.length > 1 ? HIDE_REASONS.ambiguous : HIDE_REASONS.unmatched };
}

function hiddenEntry(raw, reason, extra = {}) {
  return {
    title: String(raw.title ?? 'An AI suggestion').slice(0, 140),
    area: normalizeArea(raw.area),
    file: raw.file ?? null,
    ref: raw.ref ?? null,
    reason,
    removedBy: 'line check',
    ...extra,
  };
}

/**
 * The line check. An AI item stays only if its file, line and quoted code are
 * found in the real diff. Returns { items, hidden }; items carry snippet and link.
 */
export function lineCheck(aiItems, diff) {
  const items = [];
  const hidden = [];
  for (const raw of aiItems) {
    const area = normalizeArea(raw.area);
    if (!area) {
      hidden.push(hiddenEntry(raw, HIDE_REASONS.area));
      continue;
    }
    const file = findFile(diff, raw.file);
    if (!file) {
      hidden.push(hiddenEntry(raw, HIDE_REASONS.file));
      continue;
    }
    const spot = locate(file, parseRef(raw.ref), raw.evidence);
    if (spot.reason) {
      hidden.push(hiddenEntry(raw, spot.reason, { file: file.path }));
      continue;
    }
    items.push(attachProof({
      id: null,
      area,
      origin: 'ai',
      confidence: null,
      title: String(raw.title).trim().slice(0, 140),
      severity: normalizeSeverity(raw.severity),
      file: file.path,
      side: spot.side,
      line: spot.number,
      moved: spot.moved,
      evidence: normalizeCode(raw.evidence),
      why: String(raw.why ?? '').trim(),
      fix: String(raw.fix ?? '').trim(),
      comment: String(raw.comment ?? '').trim(),
      detail: null,
      snippet: null,
      link: null,
    }, diff));
  }
  return { items, hidden };
}

/**
 * Merges AI items with the facts and hints. An AI item in the same area and file as a
 * hint, on the same line or up to NEAR_LINES lines away (the AI often cites the loop
 * while the pattern flags the query inside it), replaces the hint (it carries a better
 * explanation) and is tagged "Pattern and AI agree". Two AI items on one line and area
 * become one, keeping the higher severity.
 */
export const NEAR_LINES = 3;
export function mergeItems(aiItems, otherItems) {
  const order = ['must-fix', 'worth-asking', 'good-to-know'];
  const key = (item) => `${item.area}|${item.file}|${item.side}${item.line}`;
  const merged = new Map();
  for (const item of aiItems) {
    const existing = merged.get(key(item));
    if (!existing) merged.set(key(item), item);
    else if (order.indexOf(item.severity) < order.indexOf(existing.severity)) existing.severity = item.severity;
  }
  const result = [...merged.values()];
  // The closest AI item that no other hint has matched yet.
  const twinOf = (hint) => {
    if (!hint.line) return null;
    const exact = merged.get(key(hint));
    if (exact && exact.origin !== 'agree') return exact;
    let best = null;
    for (const item of result) {
      if (item.origin !== 'ai' || item.area !== hint.area || item.file !== hint.file || item.side !== hint.side) continue;
      const distance = Math.abs(item.line - hint.line);
      if (distance <= NEAR_LINES && (!best || distance < Math.abs(best.line - hint.line))) best = item;
    }
    return best;
  };
  for (const other of otherItems) {
    const twin = other.origin === 'hint' ? twinOf(other) : null;
    if (twin) {
      twin.origin = 'agree';
      twin.key = other.key;
      if (order.indexOf(other.severity) < order.indexOf(twin.severity)) twin.severity = other.severity;
    } else {
      result.push(other);
    }
  }
  return result;
}
