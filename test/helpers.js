// Shared test helpers: a stand-in AI client and the saved AI replies.
import fs from 'node:fs';

export function savedReply(name) {
  return JSON.parse(fs.readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8')).content;
}

/** An AI client that answers from a list (strings, or functions of the messages, or errors to throw). */
export function fakeAi(replies, model = 'test/model') {
  const calls = [];
  return {
    model,
    calls,
    async chat(messages, options = {}) {
      calls.push({ messages, options });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(messages) : next;
    },
    async listModels() {
      return [model];
    },
  };
}
