import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { loadSample } from '../lib/review.js';
import { fakeAi } from './helpers.js';

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
  assert.deepEqual(await res.json(), { ai: false, model: null, problem: null });
});

test('unknown addresses get the friendly page, unknown API calls get JSON', async () => {
  const page = await fetch(`${base}/nope`);
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Nothing to<br><i>review here/);
  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error.code, 'not-found');
});

test('the app page loads its files from the site root, so /app/ works too', async () => {
  const html = await (await fetch(`${base}/app/`)).text();
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
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
    ['security', 'issues'], ['tests', 'issues'], ['breaking', 'issues'], ['docs', 'issues'], ['performance', 'issues'],
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

test('a PR link streams the fetch step; a bad link gets the plain message', async () => {
  const sample = loadSample('demo');
  const github = { readPr: async () => ({ ...sample, fetchedAt: Date.now(), fromCache: false }) };
  const app = createApp({ settings: { nvidiaKey: '', model: 'm', githubToken: '', claimCheck: true, port: 0 }, github });
  const local = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${local.address().port}/api/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    };
    const good = await post({ url: 'https://github.com/manangoesagain/bookshop-demo/pull/1' });
    assert.deepEqual(good.slice(0, -1), [{ step: 'fetch' }, { step: 'facts' }]);
    assert.equal(good.at(-1).review.pr.title, 'Add order search');
    const bad = await post({ url: 'https://github.com/a/b/issues/1' });
    assert.deepEqual(bad, [{ error: { code: 'not-a-pr', message: 'That doesn\'t look like a pull request link. It should end in /pull/ and a number.' } }]);
  } finally {
    local.close();
  }
});

test('Cancel on the page stops the review on the server', async () => {
  let aborted = null;
  let started;
  const chatStarted = new Promise((resolve) => { started = resolve; });
  const ai = {
    model: 'test/model',
    chat: (messages, { signal }) => new Promise((_, reject) => {
      started();
      const keepAlive = setTimeout(() => {}, 10_000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); aborted = true; reject(signal.reason); });
    }),
    listModels: async () => ['test/model'],
  };
  const app = createApp({ settings: { nvidiaKey: 'x', model: 'test/model', githubToken: '', claimCheck: true, port: 0 }, ai });
  const local = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${local.address().port}/api/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sample: true }), signal: controller.signal,
    }).then((res) => res.text());
    await chatStarted;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    for (let i = 0; i < 50 && aborted === null; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(aborted, true, 'the AI request was cancelled too');
  } finally {
    local.close();
  }
});

test('a model swapped in by the startup check is the one reviews use', async () => {
  const app = createApp({ settings: { nvidiaKey: 'x', model: 'old/model', githubToken: '', claimCheck: false, port: 0 }, ai: fakeAi([new Error('old model used')], 'old/model') });
  app.locals.ai = fakeAi(['{"items":[],"clear":["security","tests","breaking","docs","performance"]}'], 'new/model');
  const local = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const port = local.address().port;
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.model, 'new/model');
    const text = await (await fetch(`http://127.0.0.1:${port}/api/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sample: 'clean' }),
    })).text();
    const last = JSON.parse(text.trim().split('\n').at(-1));
    assert.equal(last.review.mode, 'ai');
  } finally {
    local.close();
  }
});

test('the landing page is at / and the app at /app', async () => {
  const landing = await (await fetch(`${base}/`)).text();
  assert.match(landing, /mountScrollWorld/);
  const app = await fetch(`${base}/app`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /id="review-form"/);
});
