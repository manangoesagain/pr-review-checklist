// Talks to the AI service (NVIDIA's OpenAI-style chat API) and turns its reply
// into checked JSON. Problems become an AiError with a plain message, so the
// review can fall back to basic mode instead of failing.

import { z } from 'zod';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const TIMEOUT_MS = 60_000;

export class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
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
  if (status === 404) return { code: 'model', message: `The model "${model}" wasn't found. Pick a model from build.nvidia.com and set AI_MODEL in .env.` };
  if (status >= 500) return { code: 'down', message: 'The AI service had a problem. Try again in a minute.' };
  return { code: 'http', message: `The AI service answered with an error (${status}).` };
}

/** A small client for the chat API. `fetchImpl` lets tests stand in for the network. */
export function createAiClient({ apiKey, model, baseUrl = NVIDIA_BASE_URL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  let guidedJsonWorks = true;

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

  async function chat(messages, { schema, maxTokens = 3000, signal } = {}) {
    const body = { model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false };
    let response = await request('/chat/completions', {
      method: 'POST',
      body: schema && guidedJsonWorks ? { ...body, nvext: { guided_json: schema } } : body,
      signal,
    });
    // Some models don't accept the JSON-shape option; ask again plainly and remember.
    if (schema && guidedJsonWorks && (response.status === 400 || response.status === 422)) {
      guidedJsonWorks = false;
      response = await request('/chat/completions', { method: 'POST', body, signal });
    }
    if (!response.ok) {
      const { code, message } = messageFor(response.status, model);
      throw new AiError(code, message);
    }
    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiError('empty', 'The AI reviewer sent an empty answer.');
    return content;
  }

  async function listModels(signal) {
    const response = await request('/models', { signal });
    if (!response.ok) {
      const { code, message } = messageFor(response.status, model);
      throw new AiError(code, message);
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

/** Startup check: is the key accepted and the model available? Returns { ok, message }. */
export async function checkAi(client) {
  try {
    const models = await client.listModels();
    if (models.length > 0 && !models.includes(client.model)) {
      return { ok: false, message: `The model "${client.model}" isn't in NVIDIA's list. Pick one from build.nvidia.com and set AI_MODEL in .env.` };
    }
    await client.chat([{ role: 'user', content: 'Reply with the word OK.' }], { maxTokens: 5 });
    return { ok: true, message: `AI reviewer ready (${client.model}).` };
  } catch (error) {
    return { ok: false, message: error instanceof AiError ? error.message : 'Couldn\'t check the AI service.' };
  }
}
