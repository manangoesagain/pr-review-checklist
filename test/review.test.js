import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../lib/ai.js';
import { runReview } from '../lib/review.js';
import { fakeAi, savedReply } from './helpers.js';

const flat = (review) => review.areas.flatMap((a) => a.items);
const where = (item) => `${item.file}:${item.side}${item.line}`;
// The review reply, then the claim check's verdicts, as the real AI would send them.
const demoAi = () => fakeAi([savedReply('demo-ai-reply'), savedReply('demo-claims-reply')]);

test('AI review of the demo PR: all five planted issues, each at the right line', async () => {
  const steps = [];
  const review = await runReview({ sample: 'demo' }, { ai: demoAi(), onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, ['facts', 'ai', 'verify']);
  assert.equal(review.mode, 'ai');
  assert.equal(review.model, 'test/model');
  const items = flat(review);
  const find = (area, file) => items.find((i) => i.area === area && (file ? i.file === file : true));
  assert.equal(where(find('security', 'src/search.ts')), 'src/search.ts:R15');
  assert.equal(find('tests').title, 'Code changed, but no tests did');
  assert.equal(where(find('breaking', 'src/users.ts')), 'src/users.ts:R16');
  assert.ok(items.some((i) => i.area === 'docs' && /README/.test(i.title)));
  assert.equal(where(find('performance', 'src/orders.ts')), 'src/orders.ts:R24');
  assert.ok(review.areas.every((a) => a.status === 'issues'));
});

test('every item with a line shows the exact code from that line', async () => {
  const review = await runReview({ sample: 'demo' }, { ai: demoAi() });
  for (const item of flat(review).filter((i) => i.line)) {
    const hit = item.snippet.find((row) => row.hit);
    assert.equal(hit.line, item.line, item.title);
    assert.ok(hit.text.replace(/\s+/g, ' ').includes(item.evidence.replace(/\s+/g, ' ')) || item.origin !== 'ai', item.title);
  }
});

test('made-up references never become items; they are listed as hidden', async () => {
  const review = await runReview({ sample: 'demo' }, { ai: demoAi() });
  assert.ok(!flat(review).some((i) => i.file === 'src/payments.ts'));
  assert.deepEqual(review.hidden.map((h) => [h.title, h.reason]), [
    ['Payment amount isn\'t validated', 'its file isn\'t in this PR'],
    ['Empty search isn\'t tested', 'it couldn\'t be matched to the code'],
    ['searchOrders has no test', 'the AI\'s answer was incomplete'],
    ['Raw SQL built from user input', 'the second check rejected it: The query uses a ? placeholder and passes userId separately, so the value isn\'t built into the SQL.'],
  ]);
});

test('if the claim check fails, AI items stay, marked unconfirmed, with a note', async () => {
  const review = await runReview({ sample: 'demo' }, { ai: fakeAi([savedReply('demo-ai-reply'), 'not json']) });
  assert.equal(review.mode, 'ai');
  const ai = flat(review).filter((i) => i.origin === 'ai');
  assert.ok(ai.length > 0 && ai.every((i) => i.confidence === 'unconfirmed'));
  assert.ok(flat(review).some((i) => i.file === 'src/orders.ts' && i.line === 19), 'nothing was rejected');
  assert.ok(review.notes.some((n) => /didn't answer/.test(n)));
});

test('if the AI fails, the basic checklist comes back with the reason', async () => {
  for (const failure of [new AiError('timeout', 'The AI reviewer didn\'t answer within 60 seconds.'), 'not json', new Error('boom')]) {
    const replies = typeof failure === 'string' ? [failure, failure] : [failure];
    const review = await runReview({ sample: 'demo' }, { ai: fakeAi(replies) });
    assert.equal(review.mode, 'basic');
    assert.ok(review.aiError, String(failure));
    assert.equal(flat(review).length, 4, 'facts and hints still there');
    assert.equal(review.areas.find((a) => a.id === 'breaking').status, 'unchecked');
  }
});

test('an AI that finds nothing on the clean PR: every area checked and clear', async () => {
  const review = await runReview({ sample: 'clean' }, { ai: fakeAi(['{"items":[],"clear":["security","tests","breaking","docs","performance"]}']) });
  assert.equal(review.mode, 'ai');
  assert.equal(flat(review).length, 0);
  assert.ok(review.areas.every((a) => a.status === 'clear'));
});

test('without an AI client, no AI steps run', async () => {
  const steps = [];
  const review = await runReview({ sample: 'demo' }, { onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, ['facts']);
  assert.equal(review.mode, 'basic');
  assert.equal(review.aiError, null);
});
