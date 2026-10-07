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
