// Talks to the AI service (NVIDIA's OpenAI-style chat API) and turns its reply
// into checked JSON. Problems become an AiError with a plain message, so the
// review can fall back to basic mode instead of failing.

import { z } from 'zod';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const TIMEOUT_MS = 90_000;

// NVIDIA retires models every few months (meta/llama-3.3-70b-instruct went in
// August 2026), so at startup the app tries these in order, skipping any that
// NVIDIA doesn't list for the key, and uses the first that answers.
export const MODEL_CHOICES = [
  'openai/gpt-oss-120b',
  'nvidia/nemotron-3-super-120b-a12b',
  'deepseek-ai/deepseek-v3.2',
  'moonshotai/kimi-k2-instruct-0905',
  'qwen/qwen3-coder-480b-a35b-instruct',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'minimaxai/minimax-m2.7',
  'openai/gpt-oss-20b',
];

export class AiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Extra request settings for reasoning models. They think before answering, and the
 * thinking counts against the answer's length limit, so it's kept short or turned off.
 */
export function modelSettings(model) {
  if (/nemotron-3|qwen3/i.test(model)) return { chat_template_kwargs: { enable_thinking: false } };
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low' };
  return null;
}

const AiItem = z.object({
  area: z.string(),
  file: z.string(),
  ref: z.union([z.string(), z.number()]).transform(String),
  evidence: z.string(),
  title: z.string().min(1),
  severity: z.string().default('worth-asking'),
  why: z.string().default(''),
  fix: z.string().default(''),
  comment: z.string().default(''),
});

const AiReply = z.object({
  items: z.array(z.unknown()).default([]),
  clear: z.array(z.string()).default([]),
});

/** Pulls the JSON object out of a reply that may have <think> notes or ``` fences around it. */
export function extractJson(text) {
  const cleaned = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AiError('bad-json', 'The AI reply had no JSON in it.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new AiError('bad-json', 'The AI reply was not valid JSON.');
  }
}

/**
 * Checks the reply's shape. Items missing a required field are set aside with a
 * reason rather than failing the whole review.
 */
export function parseReply(text) {
  const parsed = AiReply.safeParse(extractJson(text));
  if (!parsed.success) throw new AiError('bad-json', 'The AI reply didn\'t match the expected shape.');
  const items = [];
  const incomplete = [];
  for (const raw of parsed.data.items) {
    const item = AiItem.safeParse(raw);
    if (item.success) items.push(item.data);
    else incomplete.push({ title: typeof raw?.title === 'string' ? raw.title : 'An AI suggestion', file: raw?.file ?? null, ref: raw?.ref ?? null });
  }
  return { items, clear: parsed.data.clear, incomplete };
}

function messageFor(status, model) {
  if (status === 401 || status === 403) return { code: 'auth', message: 'The NVIDIA key was refused. Copy it again from build.nvidia.com (it starts with nvapi-) into .env.' };
  if (status === 402 || status === 429) return { code: 'quota', message: 'The AI service is busy or out of credits. Try again in a minute.' };
  if (status === 404 || status === 410) return { code: 'model', message: `NVIDIA no longer offers the AI model "${model}" (error ${status}). Restart the app and it will look for one that works.` };
  if (status >= 500) return { code: 'down', message: 'The AI service had a problem. Try again in a minute.' };
  return { code: 'http', message: `The AI service answered with an error (${status}).` };
}

/** A small client for the chat API. `fetchImpl` lets tests stand in for the network. */
export function createAiClient({ apiKey, model, baseUrl = NVIDIA_BASE_URL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  let guidedJsonWorks = true;
  let settingsWork = true;

  async function request(pathName, { method = 'GET', body, signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathName}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error; // The person pressed Cancel.
      if (timeout.aborted) throw new AiError('timeout', `The AI reviewer didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      throw new AiError('network', 'Couldn\'t reach the AI service. Check your internet connection.');
    }
    return response;
  }

  async function chat(messages, { schema, maxTokens = 4096, signal } = {}) {
    const extras = modelSettings(model);
    // Some models refuse the JSON-shape option or the reasoning settings (400 or 422),
    // and with some the shape option leaves the answer empty. Then the request goes
    // again without that option, and the client remembers for next time.
    for (;;) {
      const useShape = Boolean(schema) && guidedJsonWorks;
      const useExtras = Boolean(extras) && settingsWork;
      const body = {
        model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false,
        ...(useExtras ? extras : {}),
        ...(useShape ? { nvext: { guided_json: schema } } : {}),
      };
      const response = await request('/chat/completions', { method: 'POST', body, signal });
      if ((response.status === 400 || response.status === 422) && (useShape || useExtras)) {
        if (useShape) guidedJsonWorks = false;
        else settingsWork = false;
        continue;
      }
      if (!response.ok) {
        const { code, message } = messageFor(response.status, model);
        throw new AiError(code, message, response.status);
      }
      const data = await response.json().catch(() => null);
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content === 'string' && content.trim()) return content;
      if (useShape) {
        guidedJsonWorks = false;
        continue;
      }
      if (choice?.finish_reason === 'length') throw new AiError('length', `The AI model "${model}" ran out of room before it answered.`);
      throw new AiError('empty', 'The AI reviewer sent an empty answer.');
    }
  }

  async function listModels(signal) {
    const response = await request('/models', { signal });
    if (!response.ok) {
      const { code, message } = messageFor(response.status, model);
      throw new AiError(code, message, response.status);
    }
    const data = await response.json().catch(() => ({}));
    return (data.data ?? []).map((m) => m.id);
  }

  return { model, chat, listModels };
}

/**
 * Asks for the review and returns { items, clear, incomplete }. A reply that isn't
 * valid JSON gets one retry with a reminder; a second bad reply throws.
 */
export async function askForReview(client, messages, { schema, signal } = {}) {
  const first = await client.chat(messages, { schema, signal });
  try {
    return parseReply(first);
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
  }
  const retry = [
    ...messages,
    { role: 'assistant', content: first.slice(0, 4000) },
    { role: 'user', content: 'Your last reply was not valid JSON matching the shape in the rules. Reply again with JSON only, no other text.' },
  ];
  const second = await client.chat(retry, { schema, signal });
  return parseReply(second);
}

const PROBE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const PROBE_SECONDS = 30;
const MAX_TRIES = 6;
// Problems that another model wouldn't fix.
const STOPS_SEARCH = new Set(['auth', 'network', 'quota']);

/** One tiny request shaped like a review. Returns null if the model answered with JSON, or the problem. */
async function probe(client) {
  try {
    const reply = await client.chat(
      [{ role: 'user', content: 'Reply with this JSON and nothing else: {"ok": true}' }],
      { schema: PROBE_SCHEMA, maxTokens: 1024, signal: AbortSignal.timeout(PROBE_SECONDS * 1000) },
    );
    extractJson(reply);
    return null;
  } catch (error) {
    if (error instanceof AiError) return error;
    if (error?.name === 'TimeoutError') return new AiError('timeout', `It didn't answer within ${PROBE_SECONDS} seconds.`);
    return new AiError('other', 'It failed in an unexpected way.');
  }
}

const NOT_CHAT = /embed|rerank|retriev|guard|safety|reward|clip|vision|-vl\b|vlm|parse|ocr|asr|tts|whisper|riva|bge|flux|diffusion|sdxl|cosmos|segment|detect|pii|translate|ingest/i;

/** The ids in NVIDIA's list that look like chat models, for suggestions and --list. */
export function chatModels(ids) {
  return [...new Set(ids)].filter((id) => !NOT_CHAT.test(id)).sort();
}

const whyFailed = (error) => (error.code === 'model' ? `NVIDIA no longer offers it (error ${error.status}).` : error.message);

/**
 * Startup check. Sends the chosen model one tiny request; if it's retired or doesn't
 * answer properly, tries MODEL_CHOICES that NVIDIA lists for this key and switches to
 * the first that answers. Returns { client, ok, switched, message }.
 */
export async function resolveAi({
  apiKey,
  model,
  choices = MODEL_CHOICES,
  makeClient = (id) => createAiClient({ apiKey, model: id }),
  log = () => {},
}) {
  const first = makeClient(model);
  const problem = await probe(first);
  if (!problem) return { client: first, ok: true, switched: false, message: `AI reviewer ready (${model}).` };
  if (STOPS_SEARCH.has(problem.code)) return { client: first, ok: false, switched: false, message: problem.message };

  log(`AI reviewer: ${model} didn't work. ${whyFailed(problem)}`);
  let listed = [];
  try {
    listed = await first.listModels();
  } catch {
    // Without the list, try the usual models anyway.
  }
  const candidates = choices.filter((id) => id !== model && (listed.length === 0 || listed.includes(id))).slice(0, MAX_TRIES);
  for (const id of candidates) {
    log(`AI reviewer: trying ${id}...`);
    const client = makeClient(id);
    const result = await probe(client);
    if (!result) {
      return { client, ok: true, switched: true, message: `AI reviewer ready (${id}). To skip this search next time, set AI_MODEL=${id} in .env.` };
    }
    log(`AI reviewer: ${id} didn't work either. ${whyFailed(result)}`);
    if (STOPS_SEARCH.has(result.code)) return { client: first, ok: false, switched: false, message: result.message };
  }
  const others = chatModels(listed).filter((id) => id !== model && !candidates.includes(id)).slice(0, 6);
  const next = others.length
    ? `Your key also lists: ${others.join(', ')}. Put one after AI_MODEL= in .env and restart.`
    : 'Pick a chat model on build.nvidia.com, put it after AI_MODEL= in .env and restart.';
  return { client: first, ok: false, switched: false, message: `${model} didn't work, and no replacement answered. ${next}` };
}
