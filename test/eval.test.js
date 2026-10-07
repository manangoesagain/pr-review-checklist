import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkSamples } from '../demo/build-demo.js';
import { formatReport, PLANTED, runEval, scoreClean, scoreDemo } from '../eval/run-eval.js';
import { loadSample, runReview } from '../lib/review.js';
import { fakeAi, savedReply } from './helpers.js';

const EMPTY = '{"items":[],"clear":["security","tests","breaking","docs","performance"]}';
const savedReplies = (model, pr) => (pr === 'demo'
  ? fakeAi([savedReply('demo-ai-reply'), savedReply('demo-claims-reply')], model)
  : fakeAi([EMPTY], model));

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

test('the saved samples are exactly the demo repo\'s diffs', { skip: !hasGit && 'git is not installed' }, () => {
  const results = checkSamples();
  assert.deepEqual(results.map((r) => [r.file, r.matches]), [['demo-pr.json', true], ['clean-pr.json', true]]);
  assert.equal(results[0].headSha, loadSample('demo').pr.head.sha);
});

test('scoring: the saved AI reply finds all five planted issues and nothing on the clean PR', async () => {
  const demo = scoreDemo(await runReview({ sample: 'demo' }, { ai: savedReplies('m', 'demo') }));
  assert.deepEqual(demo.found, { security: true, tests: true, breaking: true, docs: true, performance: true });
  assert.deepEqual(demo.otherTitles, ['README still shows the old user response', 'Search returns every matching order']);
  assert.deepEqual(demo.hidden, { line: 3, claim: 1, limit: 0 });
  const clean = scoreClean(await runReview({ sample: 'clean' }, { ai: savedReplies('m', 'clean') }));
  assert.equal(clean.falseAlarms, 0);
});

test('basic mode misses the breaking change: the AI is what finds it', async () => {
  const demo = scoreDemo(await runReview({ sample: 'demo' }));
  assert.deepEqual(Object.entries(demo.found).filter(([, found]) => !found).map(([id]) => id), ['breaking']);
});

test('the report adds up runs and lists false alarms by name', async () => {
  const noisy = (model, pr) => (pr === 'clean'
    ? fakeAi([JSON.stringify({ items: [{ area: 'security', file: 'src/books.ts', ref: 'R18', evidence: 'const digits = input.replace(/-/g, "");', title: 'Made-up worry', severity: 'must-fix', why: 'x', fix: 'y', comment: 'z' }], clear: [] }), '{"verdicts":[{"id":1,"verdict":"confirmed","reason":"ok"}]}'], model)
    : savedReplies(model, pr));
  const results = await runEval({ models: ['m1'], runs: 2, aiFor: noisy });
  const [r] = results;
  assert.equal(r.plantedTotal, 10);
  assert.equal(r.fallbacks, 0);
  const report = formatReport(results);
  assert.match(report, /Planted issues found on the demo PR: 10 of 10 \(100%\)/);
  assert.match(report, /Hidden per run on the demo PR: +3 by the line check, 1 by the claim check, 0 over the limit/);
  assert.match(report, /False alarms on the clean PR: +1 per run \(most in one run: 1\)\n +2x Made-up worry \(src\/books\.ts:18\)/);
  assert.equal(PLANTED.length, 5);
});

test('runs where the AI fails are counted, not scored', async () => {
  const failing = () => fakeAi([new Error('down')]);
  const [r] = await runEval({ models: ['m'], runs: 1, aiFor: failing });
  assert.equal(r.fallbacks, 2);
  assert.match(formatReport([r]), /The AI didn't answer in 2 of 2 reviews; those runs aren't scored\./);
  assert.match(formatReport([r]), /No AI reviews finished/);
});
