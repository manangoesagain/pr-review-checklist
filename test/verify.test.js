import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFromGitHub, diffFromText } from '../lib/diff.js';
import { loadSample } from '../lib/review.js';
import { attachProof, githubLink, snippetFor } from '../lib/verify.js';

test('snippets show 2 rows either side from the same hunk, with the flagged line marked', () => {
  const diff = diffFromGitHub(loadSample('demo'));
  const users = diff.files.find((f) => f.path === 'src/users.ts');
  const rows = snippetFor(users, 'R', 16);
  assert.deepEqual(rows.map((r) => [r.line, r.type, r.hit]), [
    [15, 'ctx', false], [16, 'del', false], [16, 'add', true], [17, 'ctx', false],
  ]);
});

test('links point at the PR commit for new lines and the base commit for removed lines', () => {
  const diff = diffFromGitHub(loadSample('demo'));
  const users = diff.files.find((f) => f.path === 'src/users.ts');
  assert.equal(githubLink(diff, users, 'R', 16), `https://github.com/manangoesagain/bookshop-demo/blob/${diff.headSha}/src/users.ts#L16`);
  assert.equal(githubLink(diff, users, 'L', 16), `https://github.com/manangoesagain/bookshop-demo/blob/${diff.baseSha}/src/users.ts#L16`);
});

test('pasted diffs get snippets but no links', () => {
  const diff = diffFromText('--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n x\n+y\n');
  const item = attachProof({ file: 'a.js', side: 'R', line: 2 }, diff);
  assert.equal(item.link, null);
  assert.deepEqual(item.snippet.map((r) => r.text), ['x', 'y']);
});

test('odd repo names or commit ids never become links', () => {
  const diff = { source: 'github', repo: 'evil.com/x/../y', headSha: 'abc1234', files: [] };
  assert.equal(githubLink(diff, { path: 'a.js' }, 'R', 1), null);
});

/* ---------- The line check ---------- */

import { classifyDiff } from '../lib/classify.js';
import { evidenceMatches, lineCheck, mergeItems, normalizeArea, normalizeSeverity, parseRef } from '../lib/verify.js';

const demoDiff = () => classifyDiff(diffFromGitHub(loadSample('demo')));
const ai = (fields) => ({ area: 'security', file: 'src/search.ts', ref: 'R15', evidence: 'db.query(`SELECT * FROM orders WHERE title LIKE \'%${q}%\'`)', title: 'T', severity: 'must-fix', why: '', fix: '', comment: '', ...fields });

test('refs, areas and severities are read generously', () => {
  assert.deepEqual(parseRef('R15'), { side: 'R', number: 15 });
  assert.deepEqual(parseRef('l41'), { side: 'L', number: 41 });
  assert.deepEqual(parseRef('Line 7'), { side: 'R', number: 7 });
  assert.deepEqual(parseRef('R15-R17'), { side: 'R', number: 15 });
  assert.equal(parseRef('somewhere'), null);
  assert.equal(normalizeArea('Breaking changes'), 'breaking');
  assert.equal(normalizeArea('Documentation'), 'docs');
  assert.equal(normalizeArea('style'), null);
  assert.equal(normalizeSeverity('Must fix'), 'must-fix');
  assert.equal(normalizeSeverity('low'), 'good-to-know');
  assert.equal(normalizeSeverity('???'), 'worth-asking');
});

test('evidence matches ignoring a copied prefix and spacing, but not tiny fragments', () => {
  assert.ok(evidenceMatches('R15   |+  const   rows = 1;', '  const rows = 1;'));
  assert.ok(evidenceMatches('rows = 1', '  const rows = 1;'));
  assert.ok(!evidenceMatches('}', '  return rows; }'));
  assert.ok(!evidenceMatches('', 'x'));
});

test('a correct item stays, with its snippet and link', () => {
  const { items, hidden } = lineCheck([ai({})], demoDiff());
  assert.equal(hidden.length, 0);
  assert.equal(items[0].line, 15);
  assert.equal(items[0].moved, false);
  assert.equal(items[0].snippet.find((r) => r.hit).line, 15);
  assert.match(items[0].link, /search\.ts#L15$/);
});

test('a line a few off snaps to where the quoted code is', () => {
  const { items } = lineCheck([ai({ area: 'performance', file: 'src/orders.ts', ref: 'R22', evidence: 'order.items = (await db.query(' })], demoDiff());
  assert.equal(items[0].line, 24);
  assert.equal(items[0].moved, true);
});

test('a line far off moves only if the quote appears exactly once in the file', () => {
  const { items } = lineCheck([ai({ file: 'src/app.ts', ref: 'R5', evidence: 'res.json(await searchOrders(q));' })], demoDiff());
  assert.equal(items[0].line, 25);
  const twice = lineCheck([ai({ file: 'src/app.ts', ref: 'R2', evidence: 'async (req, res) => {' })], demoDiff());
  assert.equal(twice.hidden[0].reason, 'the code it quotes appears on several lines');
});

test('a removed line keeps its old-file reference', () => {
  const { items } = lineCheck([ai({ area: 'breaking', file: 'src/users.ts', ref: 'L16', evidence: 'return { id: u.id, name: u.name };' })], demoDiff());
  assert.equal(items[0].side, 'L');
  assert.equal(items[0].line, 16);
  assert.match(items[0].link, new RegExp(`${loadSample('demo').pr.base.sha}/src/users\\.ts#L16$`));
});

test('made-up files, made-up code and unknown areas are hidden with a reason', () => {
  const { items, hidden } = lineCheck([
    ai({ file: 'src/payments.ts' }),
    ai({ ref: 'R11', evidence: 'if (q.length === 0) return [];' }),
    ai({ ref: 'R200', evidence: 'return users.map(toUserResponse);' }),
    ai({ area: 'style' }),
  ], demoDiff());
  assert.equal(items.length, 0);
  assert.deepEqual(hidden.map((h) => h.reason), [
    'its file isn\'t in this PR',
    'it couldn\'t be matched to the code',
    'it couldn\'t be matched to the code',
    'it didn\'t name one of the five areas',
  ]);
  assert.ok(hidden.every((h) => h.removedBy === 'line check'));
});

test('a short file name matches when only one file ends with it', () => {
  const { items } = lineCheck([ai({ file: 'search.ts' })], demoDiff());
  assert.equal(items[0].file, 'src/search.ts');
});

test('an AI item on a hint\'s line replaces it and is tagged as agreeing', () => {
  const hint = { area: 'security', file: 'src/search.ts', side: 'R', line: 15, origin: 'hint', key: 'sql', severity: 'must-fix', title: 'hint' };
  const fact = { area: 'tests', origin: 'fact', line: null, title: 'fact' };
  const { items } = lineCheck([ai({ severity: 'worth-asking' }), ai({ title: 'dupe', severity: 'good-to-know' })], demoDiff());
  const merged = mergeItems(items, [hint, fact]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].origin, 'agree');
  assert.equal(merged[0].severity, 'must-fix');
  assert.equal(merged[0].title, 'T');
  assert.equal(merged[1], fact);
});
