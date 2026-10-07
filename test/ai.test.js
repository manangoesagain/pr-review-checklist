import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, askForReview, chatModels, createAiClient, extractJson, parseReply, resolveAi } from '../lib/ai.js';
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
    [404, 'model', /no longer offers/],
    [410, 'model', /no longer offers the AI model "m" \(error 410\)/],
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

test('reasoning models get their thinking turned down; refused settings are dropped and remembered', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 400 }, { status: 400 }, answer('{}'), answer('{}')]);
  const client = createAiClient({ apiKey: 'k', model: 'nvidia/nemotron-3-super-120b-a12b', fetchImpl });
  await client.chat([], { schema: { type: 'object' } });
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(calls[0].body.nvext);
  assert.equal(calls[1].body.nvext, undefined, 'first drops the JSON-shape option');
  assert.ok(calls[1].body.chat_template_kwargs);
  assert.equal(calls[2].body.chat_template_kwargs, undefined, 'then the thinking setting');
  await client.chat([], { schema: { type: 'object' } });
  assert.equal(calls[3].body.nvext, undefined);
  assert.equal(calls[3].body.chat_template_kwargs, undefined);

  const gpt = fakeFetch([answer('{}')]);
  await createAiClient({ apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl: gpt.fetchImpl }).chat([]);
  assert.equal(gpt.calls[0].body.reasoning_effort, 'low');
});

test('an empty answer with the JSON-shape option is asked again without it', async () => {
  const { fetchImpl, calls } = fakeFetch([answer(''), answer('{"ok":true}')]);
  const client = createAiClient({ apiKey: 'k', model: 'm', fetchImpl });
  assert.equal(await client.chat([], { schema: { type: 'object' } }), '{"ok":true}');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.nvext, undefined);
});

test('a model that thinks until it runs out of room says so', async () => {
  const { fetchImpl } = fakeFetch([{ body: { choices: [{ message: { content: '', reasoning_content: 'hmm...' }, finish_reason: 'length' }] } }]);
  const client = createAiClient({ apiKey: 'k', model: 'm', fetchImpl });
  await assert.rejects(client.chat([]), { code: 'length', message: 'The AI model "m" ran out of room before it answered.' });
});

// Stand-in clients for the startup check: each model answers, fails with an AiError, or isn't listed.
function models(behaviour, listed = Object.keys(behaviour)) {
  const tried = [];
  const makeClient = (id) => ({
    model: id,
    async chat() {
      tried.push(id);
      const outcome = behaviour[id] ?? new AiError('model', 'gone', 410);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async listModels() {
      return listed;
    },
  });
  return { tried, makeClient };
}

test('startup check: a model that answers is used as is', async () => {
  const { tried, makeClient } = models({ a: '{"ok":true}' });
  const result = await resolveAi({ model: 'a', choices: ['b'], makeClient });
  assert.equal(result.ok, true);
  assert.equal(result.switched, false);
  assert.equal(result.client.model, 'a');
  assert.equal(result.message, 'AI reviewer ready (a).');
  assert.deepEqual(tried, ['a']);
});

test('startup check: a retired model is swapped for the first listed choice that answers', async () => {
  const { tried, makeClient } = models(
    { old: new AiError('model', 'gone', 410), b: new AiError('empty', 'The AI reviewer sent an empty answer.'), d: '{"ok":true}', e: '{"ok":true}' },
    ['old', 'b', 'd', 'e'],
  );
  const lines = [];
  const result = await resolveAi({ model: 'old', choices: ['b', 'c', 'd', 'e'], makeClient, log: (line) => lines.push(line) });
  assert.equal(result.ok, true);
  assert.equal(result.switched, true);
  assert.equal(result.client.model, 'd');
  assert.deepEqual(tried, ['old', 'b', 'd'], 'c is skipped because NVIDIA doesn\'t list it');
  assert.equal(result.message, 'AI reviewer ready (d). To skip this search next time, set AI_MODEL=d in .env.');
  assert.equal(lines[0], 'AI reviewer: old didn\'t work. NVIDIA no longer offers it (error 410).');
});

test('startup check: a refused key stops the search at once', async () => {
  const { tried, makeClient } = models({ a: new AiError('auth', 'The NVIDIA key was refused.') });
  const result = await resolveAi({ model: 'a', choices: ['b', 'c'], makeClient });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'The NVIDIA key was refused.');
  assert.deepEqual(tried, ['a']);
});

test('startup check: when nothing answers, it names other models the key lists', async () => {
  const { makeClient } = models({}, ['old', 'b', 'x/chat-model', 'nvidia/nv-embedqa-e5-v5', 'meta/llama-guard-4-12b']);
  const result = await resolveAi({ model: 'old', choices: ['b'], makeClient });
  assert.equal(result.ok, false);
  assert.equal(result.client.model, 'old');
  assert.equal(result.message, 'old didn\'t work, and no replacement answered. Your key also lists: x/chat-model. Put one after AI_MODEL= in .env and restart.');
});

test('chat models are picked out of NVIDIA\'s list', () => {
  assert.deepEqual(chatModels(['openai/gpt-oss-120b', 'nvidia/llama-3.2-nv-rerankqa-1b-v2', 'nvidia/nemotron-3-embed-1b', 'deepseek-ai/deepseek-v3.2', 'openai/gpt-oss-120b']),
    ['deepseek-ai/deepseek-v3.2', 'openai/gpt-oss-120b']);
});
