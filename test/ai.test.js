import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, askForReview, createAiClient, extractJson, parseReply } from '../lib/ai.js';
import { fakeAi } from './helpers.js';

const GOOD = '{"items":[{"area":"security","file":"a.js","ref":"R1","evidence":"x","title":"T","severity":"must-fix","why":"w","fix":"f","comment":"c"}],"clear":["docs"]}';

test('JSON is found inside think notes and code fences', () => {
  assert.deepEqual(extractJson('<think>hmm { not this }</think>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('Sorry, I can\'t help.'), { code: 'bad-json' });
  assert.throws(() => extractJson('{"a": 1,,}'), { code: 'bad-json' });
});

test('items missing a field are set aside, not fatal', () => {
  const good = JSON.parse(GOOD).items[0];
  const reply = parseReply(JSON.stringify({ items: [{ area: 'tests', title: 'No test' }, good], clear: [] }));
  assert.equal(reply.items.length, 1);
  assert.deepEqual(reply.incomplete, [{ title: 'No test', file: null, ref: null }]);
});

test('a numeric ref is accepted', () => {
  const reply = parseReply(GOOD.replace('"R1"', '15'));
  assert.equal(reply.items[0].ref, '15');
});

test('broken JSON gets one retry with a reminder, then succeeds', async () => {
  const ai = fakeAi(['Here you go: {items: oops', GOOD]);
  const reply = await askForReview(ai, [{ role: 'user', content: 'review' }]);
  assert.equal(reply.items.length, 1);
  assert.equal(ai.calls.length, 2);
  assert.match(ai.calls[1].messages.at(-1).content, /not valid JSON/);
});

test('broken JSON twice is an error, so the review can fall back', async () => {
  const ai = fakeAi(['nope', 'still nope']);
  await assert.rejects(askForReview(ai, []), { code: 'bad-json' });
});

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const answer = (content) => ({ body: { choices: [{ message: { content } }] } });

test('the client asks for the JSON shape, and asks plainly if the model refuses it', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 400 }, answer('{"items":[],"clear":[]}'), answer('{}')]);
  const client = createAiClient({ apiKey: 'nvapi-test', model: 'm', fetchImpl });
  await client.chat([{ role: 'user', content: 'hi' }], { schema: { type: 'object' } });
  assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer nvapi-test');
  assert.deepEqual(calls[0].body.nvext, { guided_json: { type: 'object' } });
  assert.equal(calls[0].body.temperature, 0.2);
  assert.equal(calls[1].body.nvext, undefined);
  // Remembered: the next call doesn't try the option again.
  await client.chat([{ role: 'user', content: 'hi' }], { schema: { type: 'object' } });
  assert.equal(calls[2].body.nvext, undefined);
});

test('service errors become plain messages', async () => {
  const cases = [
    [401, 'auth', /key was refused/],
    [429, 'quota', /busy or out of credits/],
    [404, 'model', /wasn't found/],
    [503, 'down', /had a problem/],
  ];
  for (const [status, code, message] of cases) {
    const { fetchImpl } = fakeFetch([{ status }]);
    const client = createAiClient({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(client.chat([]), (error) => error instanceof AiError && error.code === code && message.test(error.message));
  }
});

test('a slow AI times out with a plain message', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 5000); // Stands in for the open network connection.
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  const client = createAiClient({ apiKey: 'k', model: 'm', fetchImpl, timeoutMs: 50 });
  await assert.rejects(client.chat([]), { code: 'timeout' });
});

test('an empty answer is an error', async () => {
  const { fetchImpl } = fakeFetch([answer('')]);
  const client = createAiClient({ apiKey: 'k', model: 'm', fetchImpl });
  await assert.rejects(client.chat([]), { code: 'empty' });
});
