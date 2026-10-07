// Runs one review from start to finish: read the input, label files, count facts,
// then build the Review the page draws. Reports each step as it starts so the
// page can show real progress.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, compareItems } from './areas.js';
import { classifyDiff } from './classify.js';
import { DiffError, diffFromGitHub, diffFromText } from './diff.js';
import { countFacts } from './facts.js';

export const MAX_PASTE_CHARS = 1_000_000;

const samplesFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const SAMPLES = { demo: 'demo-pr.json', clean: 'clean-pr.json' };

export class ReviewError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.extra = extra;
  }
}

const sampleCache = new Map();
export function loadSample(name) {
  const file = SAMPLES[name];
  if (!file) throw new ReviewError('bad-request', 'There is no sample with that name.');
  if (!sampleCache.has(name)) {
    sampleCache.set(name, JSON.parse(fs.readFileSync(path.join(samplesFolder, file), 'utf8')));
  }
  return structuredClone(sampleCache.get(name));
}

async function readInput(input, { onStep }) {
  if (input.sample) {
    return diffFromGitHub(loadSample(input.sample === true ? 'demo' : String(input.sample)));
  }
  if (typeof input.diff === 'string') {
    if (!input.diff.trim()) throw new ReviewError('empty', 'Paste a diff first, or try the sample.');
    if (input.diff.length > MAX_PASTE_CHARS) {
      throw new ReviewError('too-big', 'That diff is over 1 MB. Paste a smaller part of it, or review the PR by its link.');
    }
    try {
      return diffFromText(input.diff);
    } catch (error) {
      if (error instanceof DiffError) throw new ReviewError(error.code, error.message);
      throw error;
    }
  }
  if (typeof input.url === 'string') {
    onStep('fetch');
    throw new ReviewError('not-ready', 'Reviewing by link isn\'t built yet. Try the sample or paste a diff for now.');
  }
  throw new ReviewError('empty', 'Paste a pull request link first, or try the sample.');
}

function areaStatus(area, items, facts, mode) {
  if (items.length > 0) return 'issues';
  if (mode === 'basic') {
    // Counted facts can settle the tests area on their own; the rest need the AI.
    if (area.id === 'tests' && (facts.stats.testFiles > 0 || facts.stats.codeFiles === 0)) return 'clear';
    return 'unchecked';
  }
  return 'clear';
}

function buildReview({ diff, facts, items, mode, seconds }) {
  items.sort(compareItems);
  const counters = {};
  for (const item of items) {
    counters[item.area] = (counters[item.area] ?? 0) + 1;
    item.id = `${item.area}-${counters[item.area]}`;
  }

  return {
    mode,
    source: diff.source,
    pr: diff.source === 'paste' ? null : {
      repo: diff.repo,
      number: diff.number,
      title: diff.title,
      url: diff.url,
      headSha: diff.headSha,
      baseSha: diff.baseSha,
    },
    stats: { ...facts.stats, seconds },
    areas: AREAS.map((area) => {
      const areaItems = items.filter((item) => item.area === area.id);
      return {
        id: area.id,
        name: area.name,
        status: areaStatus(area, areaItems, facts, mode),
        note: facts.notes[area.id] ?? null,
        items: areaItems,
      };
    }),
    hidden: [],
    checked: {
      files: diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind, additions: f.additions, deletions: f.deletions })),
      skipped: diff.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    },
    notes: [],
  };
}

/**
 * input: { sample: true | "demo" | "clean" } or { diff: "..." } or { url: "..." }
 * options.onStep(step) is called with "fetch", "facts", "ai" and "verify" as each starts.
 */
export async function runReview(input = {}, { onStep = () => {}, clock = Date.now } = {}) {
  const started = clock();
  const raw = await readInput(input, { onStep });

  onStep('facts');
  const diff = classifyDiff(raw);
  if (diff.files.length === 0) {
    const names = diff.skipped.slice(0, 3).map((s) => s.path).join(', ') || 'nothing';
    throw new ReviewError('nothing-to-review', `Nothing to review: this ${diff.source === 'paste' ? 'diff' : 'PR'} only changes ${names}.`);
  }
  const facts = countFacts(diff);
  const items = [...facts.items];

  const seconds = Math.round((clock() - started) / 100) / 10;
  return buildReview({ diff, facts, items, mode: 'basic', seconds });
}
