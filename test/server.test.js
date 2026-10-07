import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

let server;
let base;

before(async () => {
  const app = createApp({ settings: { nvidiaKey: '', model: 'm', githubToken: '', claimCheck: true, port: 0 } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function review(body) {
  const res = await fetch(`${base}/api/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), lines: text.trim().split('\n').map((l) => JSON.parse(l)) };
}

test('health says basic mode when there is no AI key', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual(await res.json(), { ai: false, model: null });
});

test('the sample streams its steps, then the review', async () => {
  const { status, type, lines } = await review({ sample: true });
  assert.equal(status, 200);
  assert.match(type, /application\/x-ndjson/);
  assert.deepEqual(lines.slice(0, -1), [{ step: 'facts' }]);
  const { review: result } = lines.at(-1);
  assert.equal(result.mode, 'basic');
  assert.equal(result.pr.repo, 'manangoesagain/bookshop-demo');
  assert.equal(result.pr.title, 'Add order search');
  assert.equal(result.stats.files, 4);
  assert.deepEqual(result.areas.map((a) => [a.id, a.status]), [
    ['security', 'issues'], ['tests', 'issues'], ['breaking', 'unchecked'], ['docs', 'issues'], ['performance', 'issues'],
  ]);
  assert.equal(result.areas[1].items[0].id, 'tests-1');
  const sql = result.areas[0].items[0];
  assert.equal(`${sql.file}:${sql.line}`, 'src/search.ts:15');
  assert.equal(sql.snippet.find((row) => row.hit).line, 15);
  assert.match(sql.link, /^https:\/\/github\.com\/manangoesagain\/bookshop-demo\/blob\/[0-9a-f]{40}\/src\/search\.ts#L15$/);
});

test('the clean sample has nothing flagged and tests marked as fine', async () => {
  const { lines } = await review({ sample: 'clean' });
  const { review: result } = lines.at(-1);
  assert.equal(result.areas.find((a) => a.id === 'tests').status, 'clear');
  assert.equal(result.areas.flatMap((a) => a.items).length, 0);
});

test('a pasted diff is reviewed without PR details', async () => {
  const diff = '--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n';
  const { lines } = await review({ diff });
  const { review: result } = lines.at(-1);
  assert.equal(result.source, 'paste');
  assert.equal(result.pr, null);
  assert.deepEqual(result.checked.files.map((f) => f.path), ['src/a.js']);
});

test('errors come back as a plain message', async () => {
  const notDiff = await review({ diff: 'please review this' });
  assert.equal(notDiff.lines.at(-1).error.code, 'not-a-diff');
  assert.match(notDiff.lines.at(-1).error.message, /doesn't look like a diff/);

  const lockOnly = await review({ diff: '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{}\n+{ }\n' });
  assert.equal(lockOnly.lines.at(-1).error.message, 'Nothing to review: this diff only changes package-lock.json.');

  const empty = await review({});
  assert.equal(empty.lines.at(-1).error.code, 'empty');
});

test('a paste over 1 MB is refused politely', async () => {
  const { lines } = await review({ diff: `--- a/a\n+++ b/a\n@@ -1 +1 @@\n+${'x'.repeat(1_100_000)}\n` });
  assert.equal(lines.at(-1).error.code, 'too-big');
});
