// The evaluation: runs the real AI reviewer several times on the demo PR (five
// planted issues) and the clean PR (none), and prints how many planted issues it
// found, how many false alarms it raised, and how many items each check hid.
// Its numbers decide the model and show whether a prompt change helped.
//
//   node eval/run-eval.js                      3 runs with the model the app would use
//   node eval/run-eval.js --runs 10            more runs, steadier numbers
//   node eval/run-eval.js --list               the chat models your NVIDIA key can use
//   node eval/run-eval.js --model a,b          compare models (any from --list)
//   node eval/run-eval.js --real               also review the PRs in eval/real-prs.json
//   node eval/run-eval.js --fake               use the saved AI replies (checks this script, no key needed)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CHOICES, chatModels, createAiClient, resolveAi } from '../lib/ai.js';
import { isMainModule, loadEnvFile, readSettings } from '../lib/env.js';
import { createGitHubReader } from '../lib/github.js';
import { runReview } from '../lib/review.js';

const projectFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The five issues planted in the demo PR, and where an item must point to count as finding one. */
export const PLANTED = [
  { id: 'security', label: 'SQL built from search text', match: (i) => i.area === 'security' && i.file === 'src/search.ts' && i.line === 15 },
  { id: 'tests', label: 'No tests for new code', match: (i) => i.area === 'tests' && i.key === 'no-tests' },
  { id: 'breaking', label: 'User response shape changed', match: (i) => i.area === 'breaking' && (i.file === 'src/users.ts' || (i.file === 'src/app.ts' && i.line >= 28 && i.line <= 31)) },
  { id: 'docs', label: 'New endpoint missing from README', match: (i) => i.area === 'docs' && i.file === 'src/app.ts' && i.line >= 23 && i.line <= 25 },
  { id: 'performance', label: 'Query inside a loop', match: (i) => i.area === 'performance' && i.file === 'src/orders.ts' && i.line >= 23 && i.line <= 27 },
];

const shownItems = (review) => review.areas.flatMap((area) => area.items);

function hiddenCounts(review) {
  const counts = { line: 0, claim: 0, limit: 0 };
  for (const entry of review.hidden) {
    counts[entry.removedBy === 'claim check' ? 'claim' : entry.removedBy === 'limit' ? 'limit' : 'line']++;
  }
  return counts;
}

/** Which planted issues one review of the demo PR found, and how many other items it showed. */
export function scoreDemo(review) {
  const items = shownItems(review);
  const found = Object.fromEntries(PLANTED.map((p) => [p.id, items.some(p.match)]));
  const other = items.filter((item) => !PLANTED.some((p) => p.match(item)));
  return { found, other: other.length, otherTitles: other.map((i) => i.title), hidden: hiddenCounts(review) };
}

/** On the clean PR every shown item is a false alarm. */
export function scoreClean(review) {
  const items = shownItems(review);
  return { falseAlarms: items.length, titles: items.map((i) => `${i.title} (${i.file ?? i.area}${i.line ? `:${i.line}` : ''})`), hidden: hiddenCounts(review) };
}

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value) => Math.round(value * 10) / 10;

/**
 * Runs the evaluation. `aiFor(model, pr)` returns an AI client for one review of
 * 'demo', 'clean' or 'real' (a fresh one each time, so the fake can hand out its
 * saved replies again).
 */
export async function runEval({ models, runs, aiFor, github = null, realPrs = [], log = () => {} }) {
  const results = [];
  for (const model of models) {
    const result = { model, runs, demo: [], clean: [], fallbacks: 0, demoSeconds: [], cleanSeconds: [], real: [] };
    for (let run = 1; run <= runs; run++) {
      log(`${model}: run ${run} of ${runs}`);
      const demo = await runReview({ sample: 'demo' }, { ai: aiFor(model, 'demo') });
      const clean = await runReview({ sample: 'clean' }, { ai: aiFor(model, 'clean') });
      for (const [review, list, seconds] of [[demo, result.demo, result.demoSeconds], [clean, result.clean, result.cleanSeconds]]) {
        if (review.mode !== 'ai') result.fallbacks++;
        seconds.push(review.stats.seconds);
        list.push(review);
      }
    }
    for (const pr of realPrs) {
      log(`${model}: ${pr.url}`);
      try {
        const review = await runReview({ url: pr.url }, { ai: aiFor(model, 'real'), github });
        result.real.push({ url: pr.url, mode: review.mode, aiError: review.aiError, items: shownItems(review).map((i) => `${i.severity}: ${i.title} (${i.file ?? i.area}${i.line ? `:${i.line}` : ''})`), hidden: hiddenCounts(review) });
      } catch (error) {
        result.real.push({ url: pr.url, error: error.message });
      }
    }
    results.push(summarize(result));
  }
  return results;
}

function summarize(result) {
  const demoScores = result.demo.filter((r) => r.mode === 'ai').map(scoreDemo);
  const cleanScores = result.clean.filter((r) => r.mode === 'ai').map(scoreClean);
  const perIssue = Object.fromEntries(PLANTED.map((p) => [p.id, demoScores.filter((s) => s.found[p.id]).length]));
  const hidden = (scores, kind) => round(average(scores.map((s) => s.hidden[kind])));
  const tally = (lists) => {
    const counts = {};
    for (const list of lists) for (const title of list) counts[title] = (counts[title] ?? 0) + 1;
    return counts;
  };
  return {
    model: result.model,
    runs: result.runs,
    scored: { demo: demoScores.length, clean: cleanScores.length },
    fallbacks: result.fallbacks,
    planted: perIssue,
    plantedTotal: Object.values(perIssue).reduce((a, b) => a + b, 0),
    otherOnDemo: { average: round(average(demoScores.map((s) => s.other))), titles: tally(demoScores.map((s) => s.otherTitles)) },
    falseAlarms: { average: round(average(cleanScores.map((s) => s.falseAlarms))), max: Math.max(0, ...cleanScores.map((s) => s.falseAlarms)), titles: tally(cleanScores.map((s) => s.titles)) },
    hiddenOnDemo: { line: hidden(demoScores, 'line'), claim: hidden(demoScores, 'claim'), limit: hidden(demoScores, 'limit') },
    hiddenOnClean: { line: hidden(cleanScores, 'line'), claim: hidden(cleanScores, 'claim'), limit: hidden(cleanScores, 'limit') },
    seconds: { demo: round(average(result.demoSeconds)), clean: round(average(result.cleanSeconds)) },
    aiErrors: [...new Set([...result.demo, ...result.clean].map((r) => r.aiError).filter(Boolean))],
    real: result.real,
  };
}

/** The score table, in plain words. */
export function formatReport(results) {
  const lines = [];
  for (const r of results) {
    const scored = r.scored.demo;
    lines.push(`Model: ${r.model}  (${r.runs} ${r.runs === 1 ? 'run' : 'runs'})`);
    if (r.fallbacks > 0) lines.push(`  The AI didn't answer in ${r.fallbacks} of ${r.runs * 2} reviews; those runs aren't scored. ${r.aiErrors.join(' ')}`);
    if (scored === 0) {
      lines.push('  No AI reviews finished, so there is nothing to score.', '');
      continue;
    }
    lines.push(`  Planted issues found on the demo PR: ${r.plantedTotal} of ${PLANTED.length * scored} (${Math.round((r.plantedTotal / (PLANTED.length * scored)) * 100)}%)`);
    for (const p of PLANTED) lines.push(`    ${p.label.padEnd(34)} ${r.planted[p.id]} of ${scored}`);
    lines.push(`  Other items on the demo PR:          ${r.otherOnDemo.average} per run (read them: true, or noise?)`);
    for (const [title, count] of Object.entries(r.otherOnDemo.titles)) lines.push(`    ${count}x ${title}`);
    lines.push(`  False alarms on the clean PR:        ${r.falseAlarms.average} per run (most in one run: ${r.falseAlarms.max})`);
    for (const [title, count] of Object.entries(r.falseAlarms.titles)) lines.push(`    ${count}x ${title}`);
    lines.push(`  Hidden per run on the demo PR:       ${r.hiddenOnDemo.line} by the line check, ${r.hiddenOnDemo.claim} by the claim check, ${r.hiddenOnDemo.limit} over the limit`);
    lines.push(`  Hidden per run on the clean PR:      ${r.hiddenOnClean.line} by the line check, ${r.hiddenOnClean.claim} by the claim check, ${r.hiddenOnClean.limit} over the limit`);
    lines.push(`  Average time:                        demo ${r.seconds.demo} s, clean ${r.seconds.clean} s`);
    for (const real of r.real) {
      lines.push(`  Real PR ${real.url}`);
      if (real.error) lines.push(`    Couldn't review it: ${real.error}`);
      else {
        if (real.aiError) lines.push(`    Basic mode only: ${real.aiError}`);
        for (const item of real.items) lines.push(`    ${item}`);
        if (real.items.length === 0) lines.push('    No items.');
        lines.push(`    Hidden: ${real.hidden.line} by the line check, ${real.hidden.claim} by the claim check, ${real.hidden.limit} over the limit`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { runs: 3, models: null, real: false, fake: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runs') options.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (arg === '--model') options.models = String(argv[++i] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    else if (arg === '--real') options.real = true;
    else if (arg === '--fake') options.fake = true;
    else if (arg === '--list') options.list = true;
    else throw new Error(`Unknown option ${arg}. Use --runs N, --model a,b, --list, --real or --fake.`);
  }
  return options;
}

// Saved replies for --fake: the demo reply and its claim check, and an empty review for the clean PR.
async function fakeClients() {
  const { fakeAi, savedReply } = await import('../test/helpers.js');
  const empty = '{"items":[],"clear":["security","tests","breaking","docs","performance"]}';
  return (model, pr) => (pr === 'demo'
    ? fakeAi([savedReply('demo-ai-reply'), savedReply('demo-claims-reply')], model)
    : fakeAi([empty], model));
}

async function printModels(settings) {
  const listed = chatModels(await createAiClient({ apiKey: settings.nvidiaKey, model: settings.model }).listModels());
  const usual = MODEL_CHOICES.filter((id) => listed.includes(id));
  console.log(`Your NVIDIA key lists ${listed.length} chat models. The app tries the starred ones by itself, in this order:`);
  for (const id of usual) console.log(`  * ${id}`);
  for (const id of listed.filter((m) => !usual.includes(m))) console.log(`    ${id}`);
  console.log('\nTo compare two: node eval/run-eval.js --model first-name,second-name');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!loadEnvFile(path.join(projectFolder, '.env')).found) loadEnvFile(path.join(projectFolder, '.env.txt'));
  const settings = readSettings();
  let aiFor;
  let models;
  if (options.fake) {
    aiFor = await fakeClients();
    models = ['saved-replies'];
  } else {
    if (!settings.nvidiaKey) {
      console.log('Add NVIDIA_API_KEY to your .env file first, or run with --fake to check this script without a key.');
      process.exitCode = 1;
      return;
    }
    if (options.list) {
      await printModels(settings);
      return;
    }
    models = options.models;
    if (!models) {
      // The same startup check as the app, so the score is for the model the app would use.
      console.log(`Checking ${settings.model}...`);
      const check = await resolveAi({ apiKey: settings.nvidiaKey, model: settings.model, log: (line) => console.log(line) });
      if (!check.ok) {
        console.log(check.message);
        process.exitCode = 1;
        return;
      }
      if (check.switched) console.log(check.message);
      models = [check.client.model];
    }
    aiFor = (model) => createAiClient({ apiKey: settings.nvidiaKey, model });
  }
  const realPrs = options.real ? JSON.parse(fs.readFileSync(path.join(projectFolder, 'eval', 'real-prs.json'), 'utf8')).prs ?? [] : [];
  const github = createGitHubReader({ token: settings.githubToken });
  const results = await runEval({ models, runs: options.runs, aiFor, github, realPrs, log: (line) => console.log(line) });
  console.log(`\n${formatReport(results)}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
