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
