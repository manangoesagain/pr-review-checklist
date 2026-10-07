import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../lib/ai.js';
import { checkClaims, claimMessages } from '../lib/claims.js';
import { classifyDiff } from '../lib/classify.js';
import { diffFromGitHub } from '../lib/diff.js';
import { capAiItems, loadSample, runReview } from '../lib/review.js';
import { lineCheck } from '../lib/verify.js';
import { fakeAi, savedReply } from './helpers.js';

// The demo PR's AI items after the line check, ready for the claim check.
function aiItems() {
  const diff = classifyDiff(diffFromGitHub(loadSample('demo')));
  return { diff, items: lineCheck(parseReply(savedReply('demo-ai-reply')).items, diff).items };
}

test('the claim check shows each claim with 5 lines of code either side, flagged line marked', () => {
  const { diff, items } = aiItems();
  const [system, user] = claimMessages(items, diff);
  assert.match(system.content, /Reject any claim the code shown does not support/);
  assert.match(user.content, /Claim 1 \(security, src\/search\.ts R15\): Search text goes straight into SQL\./);
  assert.match(user.content, />> R15   \|\+  const rows = await db\.query/);
  assert.match(user.content, /   R10   \|\+export async function searchOrders/);
  assert.match(user.content, /<readme>\n# Bookshop API/, 'docs claims come with the README');
});

test('confirmed, unsure and rejected each do the right thing', async () => {
  const { diff, items } = aiItems();
  const result = await checkClaims(fakeAi([savedReply('demo-claims-reply')]), items, diff);
  assert.equal(result.failed, false);
  assert.equal(result.items.length, 6);
  assert.ok(result.items.slice(0, 5).every((i) => i.confidence === 'confirmed'));
  const unsure = result.items[5];
  assert.equal(unsure.title, 'Search returns every matching order');
  assert.equal(unsure.confidence, 'unconfirmed');
  assert.equal(unsure.severity, 'good-to-know');
  assert.equal(result.hidden.length, 1);
  assert.equal(result.hidden[0].title, 'Raw SQL built from user input');
  assert.equal(result.hidden[0].ref, 'R19');
  assert.equal(result.hidden[0].removedBy, 'claim check');
  assert.match(result.hidden[0].reason, /^the second check rejected it: The query uses a \? placeholder/);
});

test('an unsure must-fix drops to worth asking', async () => {
  const { diff, items } = aiItems();
  const [sql] = items;
  const result = await checkClaims(fakeAi(['{"verdicts":[{"id":1,"verdict":"unsure","reason":"?"}]}']), [sql], diff);
  assert.equal(result.items[0].severity, 'worth-asking');
});

test('if the claim check fails, nothing vanishes: everything is marked unconfirmed', async () => {
  const { diff, items } = aiItems();
  const result = await checkClaims(fakeAi(['not json at all']), items, diff);
  assert.equal(result.failed, true);
  assert.equal(result.items.length, items.length);
  assert.ok(result.items.every((i) => i.confidence === 'unconfirmed'));
  assert.deepEqual(result.hidden, []);
});

test('full demo review: the planted false claim is hidden, the five planted issues stay', async () => {
  const review = await runReview({ sample: 'demo' }, { ai: fakeAi([savedReply('demo-ai-reply'), savedReply('demo-claims-reply')]) });
  const items = review.areas.flatMap((a) => a.items);
  assert.ok(!items.some((i) => i.file === 'src/orders.ts' && i.line === 19));
  assert.deepEqual(review.hidden.map((h) => h.removedBy), ['line check', 'line check', 'line check', 'claim check']);
  const tags = Object.fromEntries(items.map((i) => [i.title, i.origin === 'ai' ? `ai:${i.confidence}` : i.origin]));
  assert.equal(tags['Search text goes straight into SQL'], 'agree');
  assert.equal(tags['User response shape changed'], 'ai:confirmed');
  assert.equal(tags['Search returns every matching order'], 'ai:unconfirmed');
  assert.equal(tags['Code changed, but no tests did'], 'fact');
  assert.ok(review.areas.every((a) => a.status === 'issues'));
});

test('with the claim check off, AI items are unconfirmed and a note says why', async () => {
  const review = await runReview({ sample: 'demo' }, { ai: fakeAi([savedReply('demo-ai-reply')]), claimCheck: false });
  const ai = review.areas.flatMap((a) => a.items).filter((i) => i.origin === 'ai');
  assert.ok(ai.length > 0 && ai.every((i) => i.confidence === 'unconfirmed'));
  assert.ok(review.notes.some((n) => /CLAIM_CHECK=off/.test(n)));
});

test('at most 3 AI items per area and 12 in all; the rest are listed as hidden', () => {
  const areas = ['security', 'tests', 'breaking', 'docs', 'performance'];
  const items = Array.from({ length: 20 }, (_, i) => ({
    area: areas[i % 5], origin: i === 0 ? 'agree' : 'ai', title: `Item ${i + 1}`, severity: 'worth-asking', file: 'src/search.ts', side: 'R', line: i + 1,
  }));
  items.push({ area: 'tests', origin: 'fact', title: 'Counted', severity: 'must-fix', file: null, side: null, line: null });
  const { items: kept, hidden } = capAiItems(items);
  const ai = kept.filter((i) => i.origin === 'ai' || i.origin === 'agree');
  assert.equal(ai.length, 12);
  for (const area of areas) assert.ok(ai.filter((i) => i.area === area).length <= 3, area);
  assert.ok(kept.some((i) => i.origin === 'fact'), 'facts never count toward the limit');
  assert.equal(hidden.length, 8);
  assert.ok(hidden.every((h) => h.removedBy === 'limit'));
  assert.match(hidden[0].reason, /limit of 3 AI suggestions per area/);
});
