import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFromGitHub, diffFromText, findLine, parseDiffText, parsePatch, refOf } from '../lib/diff.js';
import { loadSample } from '../lib/review.js';

const GIT_DIFF = `diff --git a/src/users.ts b/src/users.ts
index 1111111..2222222 100644
--- a/src/users.ts
+++ b/src/users.ts
@@ -13,5 +13,5 @@ export async function getUser(id: number) {
 
 // What the API sends back for a user.
 export function toUserResponse(u: User) {
-  return { id: u.id, name: u.name };
+  return { user: { id: u.id, fullName: u.name } };
 }
diff --git a/src/search.ts b/src/search.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/search.ts
@@ -0,0 +1,3 @@
+export function search(q) {
+  return db.query(\`SELECT * FROM orders WHERE title LIKE '%\${q}%'\`);
+}
`;

test('reads both line numbers for every line', () => {
  const [users, search] = parseDiffText(GIT_DIFF);
  assert.equal(users.path, 'src/users.ts');
  assert.equal(users.status, 'modified');
  const lines = users.hunks[0].lines;
  assert.deepEqual(lines.map((l) => [l.type, l.old, l.new]), [
    ['ctx', 13, 13], ['ctx', 14, 14], ['ctx', 15, 15], ['del', 16, null], ['add', null, 16], ['ctx', 17, 17],
  ]);
  assert.equal(lines[3].text, '  return { id: u.id, name: u.name };');
  assert.equal(users.additions, 1);
  assert.equal(users.deletions, 1);

  assert.equal(search.status, 'added');
  assert.equal(search.oldPath, null);
  assert.deepEqual(search.hunks[0].lines.map((l) => l.new), [1, 2, 3]);
});

test('a diff saved with Windows line endings reads the same', () => {
  const windows = GIT_DIFF.replace(/\n/g, '\r\n');
  assert.deepEqual(parseDiffText(windows), parseDiffText(GIT_DIFF));
});

test('"\\ No newline at end of file" is not counted as a line', () => {
  const files = parseDiffText(`--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+two!
\\ No newline at end of file
`);
  const lines = files[0].hunks[0].lines;
  assert.equal(lines.length, 3);
  assert.equal(lines[1].noNewline, true);
  assert.equal(lines[2].noNewline, true);
  assert.equal(lines[2].new, 2);
});

test('a deleted line that starts with "-- " stays inside its hunk', () => {
  const files = parseDiffText(`diff --git a/db.sql b/db.sql
--- a/db.sql
+++ b/db.sql
@@ -1,3 +1,3 @@
 SELECT 1;
--- old comment
+++ new comment
 SELECT 2;
`);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.type, l.text]), [
    ['ctx', 'SELECT 1;'], ['del', '-- old comment'], ['add', '++ new comment'], ['ctx', 'SELECT 2;'],
  ]);
});

test('renamed, deleted and binary files', () => {
  const files = parseDiffText(`diff --git a/src/old name.ts b/src/new name.ts
similarity index 90%
rename from src/old name.ts
rename to src/new name.ts
index 1..2 100644
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3..0
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export default gone;
diff --git a/logo.png b/logo.png
index 4..5 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/moved.ts b/lib/moved.ts
similarity index 100%
rename from src/moved.ts
rename to lib/moved.ts
`);
  assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.status, f.binary]), [
    ['src/new name.ts', 'src/old name.ts', 'renamed', false],
    ['src/gone.ts', null, 'removed', false],
    ['logo.png', null, 'modified', true],
    ['lib/moved.ts', 'src/moved.ts', 'renamed', false],
  ]);
  assert.deepEqual(files[1].hunks[0].lines.map((l) => [l.type, l.old]), [['del', 1], ['del', 2]]);
});

test('plain diff -u output with timestamps', () => {
  const files = parseDiffText(`--- app.py\t2026-10-07 10:00:00
+++ app.py\t2026-10-07 11:00:00
@@ -1 +1,2 @@
 import os
+import subprocess
`);
  assert.equal(files[0].path, 'app.py');
  assert.equal(files[0].hunks[0].lines[1].new, 2);
});

test('text that is not a diff gets a plain message', () => {
  assert.throws(() => diffFromText('hello, please review my code'), { code: 'not-a-diff' });
});

test('GitHub patches become the same Diff model', () => {
  const sample = loadSample('demo');
  const diff = diffFromGitHub(sample);
  assert.equal(diff.source, 'github');
  assert.equal(diff.repo, 'manangoesagain/bookshop-demo');
  assert.equal(diff.headSha, sample.pr.head.sha);
  assert.match(diff.readme, /# Bookshop API/);

  const search = diff.files.find((f) => f.path === 'src/search.ts');
  const hit = findLine(search, 'R', 15);
  assert.match(hit.line.text, /SELECT \* FROM orders WHERE title LIKE '%\$\{q\}%'/);
  assert.equal(refOf(hit.line), 'R15');

  const users = diff.files.find((f) => f.path === 'src/users.ts');
  const removed = findLine(users, 'L', 16);
  assert.equal(removed.line.text, '  return { id: u.id, name: u.name };');
  assert.equal(refOf(removed.line), 'L16');
  assert.equal(findLine(users, 'R', 16).line.text, '  return { user: { id: u.id, fullName: u.name } };');

  for (const file of diff.files) {
    const sent = sample.files.find((f) => f.filename === file.path);
    assert.equal(file.additions, sent.additions, `${file.path} additions`);
    assert.equal(file.deletions, sent.deletions, `${file.path} deletions`);
  }
});

test('a GitHub file without a patch is marked so it can be skipped', () => {
  const diff = diffFromGitHub({
    pr: { number: 1, head: { sha: 'h' }, base: { sha: 'b', repo: { full_name: 'o/r' } } },
    files: [{ filename: 'huge.js', status: 'modified', additions: 9000, deletions: 0, changes: 9000 }],
  });
  assert.equal(diff.files[0].patchMissing, true);
  assert.deepEqual(parsePatch(undefined), []);
});
