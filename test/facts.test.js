import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff } from '../lib/classify.js';
import { diffFromGitHub, diffFromText } from '../lib/diff.js';
import { countFacts, newPackages } from '../lib/facts.js';
import { loadSample } from '../lib/review.js';

const factsFor = (sample) => countFacts(classifyDiff(diffFromGitHub(loadSample(sample))));
const factsForText = (text) => countFacts(classifyDiff(diffFromText(text)));

test('demo PR: code changed with no tests is a must-fix fact', () => {
  const facts = factsFor('demo');
  assert.equal(facts.stats.files, 4);
  assert.equal(facts.stats.codeFiles, 4);
  assert.equal(facts.stats.testFiles, 0);
  assert.equal(facts.stats.additions, 36);
  assert.equal(facts.stats.deletions, 11);
  const tests = facts.items.filter((i) => i.area === 'tests');
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, 'Code changed, but no tests did');
  assert.equal(tests[0].severity, 'must-fix');
  assert.equal(tests[0].detail, '4 code files changed, 0 test files');
  assert.equal(tests[0].origin, 'fact');
  assert.equal(facts.notes.docs, 'No docs changed');
  assert.ok(facts.clues.includes('The README was not changed in this PR.'));
});

test('clean PR: tests and README changed, so no fact items', () => {
  const facts = factsFor('clean');
  assert.deepEqual(facts.items, []);
  assert.equal(facts.notes.tests, '1 test file changed');
  assert.equal(facts.notes.docs, 'README changed');
});

test('a small change without tests is worth asking, not must-fix', () => {
  const facts = factsForText(`--- a/src/a.js
+++ b/src/a.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);
  assert.equal(facts.items[0].severity, 'worth-asking');
});

test('deleted and renamed code files, migrations and .env files are flagged', () => {
  const facts = factsForText(`diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
--- a/src/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-module.exports = 1;
diff --git a/src/a.js b/lib/a.js
similarity index 100%
rename from src/a.js
rename to lib/a.js
diff --git a/db/migrations/002_add_email.sql b/db/migrations/002_add_email.sql
new file mode 100644
--- /dev/null
+++ b/db/migrations/002_add_email.sql
@@ -0,0 +1 @@
+ALTER TABLE users ADD COLUMN email TEXT;
diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+API_KEY=abc
`);
  const byKey = Object.fromEntries(facts.items.map((i) => [i.key, i]));
  assert.equal(byKey['deleted-files'].detail, 'Deleted: src/gone.js');
  assert.equal(byKey['renamed-files'].detail, 'src/a.js → lib/a.js');
  assert.equal(byKey.migration.area, 'breaking');
  assert.equal(byKey['env-file'].severity, 'must-fix');
  assert.equal(byKey['env-file'].file, '.env');
});

test('new packages are found, version bumps are not', () => {
  const [file] = diffFromText(`--- a/package.json
+++ b/package.json
@@ -1,8 +1,9 @@
 {
   "name": "shop",
-  "version": "1.0.0",
+  "version": "1.1.0",
   "dependencies": {
-    "express": "^5.1.0",
+    "express": "^5.2.1",
+    "left-pad": "^1.3.0",
+    "@acme/utils": "2.x"
   }
 }
`).files;
  assert.deepEqual(newPackages(file), ['left-pad', '@acme/utils']);

  const [reqs] = diffFromText(`--- a/requirements.txt
+++ b/requirements.txt
@@ -1 +1,3 @@
 flask==3.0.0
+requests>=2.31
+# a comment
`).files;
  assert.deepEqual(newPackages(reqs), ['requests']);
});
