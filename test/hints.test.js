import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff } from '../lib/classify.js';
import { diffFromGitHub, diffFromText } from '../lib/diff.js';
import { findHints, loadRules } from '../lib/hints.js';
import { loadSample } from '../lib/review.js';

const hintsFor = (diff) => findHints(classifyDiff(diff));
const hintsForText = (text) => hintsFor(diffFromText(text));
const keys = (items) => items.map((i) => `${i.key} ${i.file}:${i.side}${i.line}`);

function added(path, ...lines) {
  return `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

test('every rule file loads and every pattern compiles', () => {
  const rules = loadRules();
  assert.deepEqual(rules.map((r) => r.area), ['security', 'tests', 'breaking', 'docs', 'performance']);
  for (const area of rules) {
    assert.ok(area.questions.length > 0, `${area.area} has questions for the AI`);
    for (const hint of area.hints) {
      for (const field of ['id', 'title', 'severity', 'why', 'fix', 'comment']) assert.ok(hint[field], `${hint.id} has ${field}`);
    }
  }
});

test('demo PR: SQL, the loop and the undocumented endpoint, at the right lines', () => {
  const items = hintsFor(diffFromGitHub(loadSample('demo')));
  assert.deepEqual(keys(items), [
    'sql-built-from-values src/search.ts:R15',
    'route-not-in-readme src/app.ts:R23',
    'call-in-loop src/orders.ts:R24',
  ]);
  const route = items.find((i) => i.key === 'route-not-in-readme');
  assert.equal(route.title, 'New endpoint /v2/orders/search isn\'t in the README');
  assert.equal(route.evidence, 'app.get("/v2/orders/search", async (req, res) => {');
});

test('clean PR: no hints at all', () => {
  assert.deepEqual(hintsFor(diffFromGitHub(loadSample('clean'))), []);
});

test('SQL hint: template strings and concatenation, but not parameters or plain text', () => {
  const items = hintsForText(added('a.js',
    'db.query(`SELECT * FROM users WHERE id = ${id}`);',
    'db.query("DELETE FROM users WHERE id = " + id);',
    'db.query("SELECT * FROM users WHERE id = ?", [id]);',
    'const msg = `Choose where to go: ${place}`;'));
  assert.deepEqual(keys(items), ['sql-built-from-values a.js:R1', 'sql-built-from-values a.js:R2']);
});

test('SQL hint: Python f-strings and % formatting, but not parameters', () => {
  const items = hintsForText(added('a.py',
    'cur.execute(f"SELECT * FROM users WHERE id = {user_id}")',
    'cur.execute("SELECT * FROM users WHERE name = \'%s\'" % name)',
    'cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))'));
  assert.deepEqual(keys(items), ['sql-built-from-values a.py:R1', 'sql-built-from-values a.py:R2']);
});

test('secrets: real-looking keys are flagged, placeholders and env lookups are not', () => {
  const items = hintsForText(added('config.js',
    'const apiKey = "sk-live-4f9c2a7b1e8d3f6a9c0b2e5d";',
    'const password = "your-password-here";',
    'const token = process.env.TOKEN;',
    'const dbPassword = "Tr0ub4dor&3horse";'));
  const security = items.filter((i) => i.area === 'security');
  assert.deepEqual(keys(security), ['secret-in-code config.js:R1', 'password-in-code config.js:R4']);
  assert.deepEqual(security.map((i) => i.severity), ['must-fix', 'worth-asking']);
});

test('secrets: test values in test files are not flagged, but a real key format still is', () => {
  const items = hintsForText(added('worker/test/paddle.test.ts',
    "const SECRET = 'whsec_test';",
    "const password = 'hunter2hunter2';",
    'const key = "AKIAABCDEFGHIJKLMNOP";'));
  assert.deepEqual(keys(items.filter((i) => i.area === 'security')), ['secret-in-code worker/test/paddle.test.ts:R3']);
  const code = hintsForText(added('src/paddle.ts', "const SECRET = 'whsec_test';", "const SECRET = 'mock-signing-key';"));
  assert.deepEqual(keys(code.filter((i) => i.area === 'security')), []);
});

test('test files: .only and .skip', () => {
  const items = hintsForText(added('test/cart.test.js', 'it.only("adds", () => {});', 'test.skip("removes", () => {});'));
  assert.deepEqual(keys(items), ['test-only test/cart.test.js:R1', 'test-skip test/cart.test.js:R2']);
});

test('removed assertions are flagged on the old line', () => {
  const items = hintsForText(`--- a/test/cart.test.js
+++ b/test/cart.test.js
@@ -1,4 +1,2 @@
 test("total", () => {
-  expect(total([1, 2])).toBe(3);
-  expect(total([])).toBe(0);
 });
`);
  assert.deepEqual(keys(items), ['assertions-removed test/cart.test.js:L2']);
  assert.equal(items[0].detail, '2 fewer checks in this file');
});

test('breaking: removed export, removed route, changed inputs', () => {
  const items = hintsForText(`--- a/src/api.js
+++ b/src/api.js
@@ -1,5 +1,4 @@
-export function getUser(id) {
+export function getUser(id, options) {
   return db.find(id);
 }
-export const LIMIT = 10;
-app.get("/v1/users", list);
+app.get("/v2/users", list);
`);
  assert.deepEqual(keys(items.filter((i) => i.area === 'breaking')), [
    'export-removed src/api.js:L4',
    'route-removed src/api.js:L5',
    'signature-changed src/api.js:R1',
  ]);
  assert.equal(items[0].title, 'Exported LIMIT removed or renamed');
  assert.equal(items[1].title, 'Route /v1/users removed or changed');
  assert.equal(items.find((i) => i.area === 'docs').title, 'New endpoint /v2/users, but no docs changed');
});

test('a call inside a loop is found; the same call outside a loop is not', () => {
  const items = hintsForText(added('src/orders.js',
    'const orders = await db.query("SELECT * FROM orders");',
    'for (const order of orders) {',
    '  order.items = await db.query("SELECT * FROM items WHERE order_id = ?", [order.id]);',
    '}',
    'await Promise.all(ids.map(async (id) => {',
    '  return fetch(`/api/${id}`);',
    '}));'));
  assert.deepEqual(keys(items), ['call-in-loop src/orders.js:R3']);
});

test('Python: a query per item in a for loop', () => {
  const items = hintsForText(added('app/orders.py',
    'for order in orders:',
    '    items = cursor.execute("SELECT * FROM items WHERE order_id = ?", (order.id,))'));
  assert.deepEqual(keys(items), ['call-in-loop app/orders.py:R2']);
});

test('settings: undocumented new env var, unless .env.example adds it', () => {
  const missing = hintsForText(added('src/db.js', 'const url = process.env.DATABASE_URL;', 'const port = process.env.PORT;'));
  assert.deepEqual(keys(missing), ['setting-not-documented src/db.js:R1']);
  const documented = hintsForText(added('src/db.js', 'const url = process.env.DATABASE_URL;') + added('.env.example', 'DATABASE_URL='));
  assert.deepEqual(documented, []);
});

test('a pasted diff with no README: the endpoint title says no docs changed', () => {
  const items = hintsForText(added('src/app.js', 'app.post("/v1/login", login);'));
  assert.equal(items[0].title, 'New endpoint /v1/login, but no docs changed');
});

test('more than 3 matches of one rule: 3 items, the first says how many', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `el${i}.innerHTML = user.name${i};`);
  const items = hintsForText(added('src/view.js', ...lines));
  assert.equal(items.length, 3);
  assert.equal(items[0].detail, 'Found on 5 lines in this PR; the first 3 are listed.');
});
