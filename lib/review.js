// Runs one review from start to finish: read the input, label files, count facts,
// then build the Review the page draws. Reports each step as it starts so the
// page can show real progress.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, compareItems, plural } from './areas.js';
import { classifyDiff } from './classify.js';
import { DiffError, diffFromGitHub, diffFromText } from './diff.js';
import { countFacts } from './facts.js';
import { AiError, askForReview } from './ai.js';
import { findHints, getRules, languageOf } from './hints.js';
import { checkClaims } from './claims.js';
import { CACHE_MINUTES, createGitHubReader, GitHubError, parsePrLink } from './github.js';
import { buildMessages, REPLY_SCHEMA } from './prompt.js';
import { attachProof, HIDE_REASONS, lineCheck, mergeItems } from './verify.js';

export const MAX_PASTE_CHARS = 1_000_000;
export const MAX_AI_PER_AREA = 3;
export const MAX_AI_TOTAL = 12;

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
  const file = Object.hasOwn(SAMPLES, name) ? SAMPLES[name] : null;
  if (!file) throw new ReviewError('bad-request', 'There is no sample with that name.');
  if (!sampleCache.has(name)) {
    sampleCache.set(name, JSON.parse(fs.readFileSync(path.join(samplesFolder, file), 'utf8')));
  }
  return structuredClone(sampleCache.get(name));
}

let defaultGitHub = null;

async function readInput(input, { onStep, signal, github }) {
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
    if (!input.url.trim()) throw new ReviewError('empty', 'Paste a pull request link first, or try the sample.');
    try {
      const link = parsePrLink(input.url);
      onStep('fetch');
      github ??= defaultGitHub ??= createGitHubReader();
      const data = await github.readPr(link, { signal });
      return { ...diffFromGitHub(data), fetchedAt: data.fetchedAt, fromCache: data.fromCache };
    } catch (error) {
      if (error instanceof GitHubError) throw new ReviewError(error.code, error.message, error.extra);
      throw error;
    }
  }
  throw new ReviewError('empty', 'Paste a pull request link first, or try the sample.');
}

function areaStatus(area, items, facts, mode, cut) {
  if (items.length > 0) return 'issues';
  // Counted facts can settle the tests area on their own; the rest need the AI.
  if (area.id === 'tests' && (facts.stats.testFiles > 0 || facts.stats.codeFiles === 0)) return 'clear';
  if (mode === 'basic') return 'unchecked';
  // The AI didn't read all of it, so "looks good" would claim more than we know.
  return cut.length > 0 ? 'partial' : 'clear';
}

// Two items on the same line in the same area are one item; the more severe one stays.
function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.line) return true;
    const key = `${item.area}|${item.file}|${item.side}${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// At most 3 AI items per area and 12 in all, most important first; the rest are listed as hidden.
export function capAiItems(items) {
  const kept = [];
  const hidden = [];
  const perArea = {};
  let total = 0;
  for (const item of [...items].sort(compareItems)) {
    if (item.origin !== 'ai' && item.origin !== 'agree') {
      kept.push(item);
      continue;
    }
    const inArea = perArea[item.area] ?? 0;
    if (inArea >= MAX_AI_PER_AREA || total >= MAX_AI_TOTAL) {
      hidden.push({
        title: item.title,
        area: item.area,
        file: item.file,
        ref: `${item.side}${item.line}`,
        reason: inArea >= MAX_AI_PER_AREA
          ? `it was over the limit of ${MAX_AI_PER_AREA} AI suggestions per area`
          : `it was over the limit of ${MAX_AI_TOTAL} AI suggestions`,
        removedBy: 'limit',
      });
      continue;
    }
    perArea[item.area] = inArea + 1;
    total++;
    kept.push(item);
  }
  return { items: kept, hidden };
}

function limitNotes(diff, cut, now) {
  const notes = ['Pattern checks are written for JavaScript, TypeScript and Python.'];
  if (diff.fromCache) {
    const minutes = Math.max(0, Math.round((now - diff.fetchedAt) / 60_000));
    const when = minutes === 0 ? 'less than a minute ago' : `${plural(minutes, 'minute')} ago`;
    notes.push(`This PR was read from GitHub ${when} and reused, so commits pushed since then aren't included. Wait ${CACHE_MINUTES} minutes to read it fresh.`);
  }
  const listed = diff.files.length + diff.skipped.length;
  if (diff.changedFiles && diff.changedFiles > listed) {
    notes.push(`This PR changes ${diff.changedFiles} files, but GitHub only lists the first ${listed}, so the rest weren't reviewed.`);
  }
  const part = cut.filter((c) => c.partial);
  const whole = cut.filter((c) => !c.partial);
  if (part.length > 0) {
    notes.push(`This PR is too big for the AI reviewer to read in full. It read only the first part of ${part.map((c) => c.path).join(', ')}; the counted facts and patterns cover the rest.`);
  }
  if (whole.length > 0) {
    const names = whole.slice(0, 5).map((c) => c.path).join(', ');
    const more = whole.length > 5 ? ` and ${whole.length - 5} more` : '';
    const lead = part.length > 0 ? '' : 'The AI reviewer read the first part of this PR. ';
    notes.push(`${lead}${whole.length === 1 ? 'This file was' : `These ${whole.length} files were`} too much to include, so only the counted facts and patterns cover ${whole.length === 1 ? 'it' : 'them'}: ${names}${more}.`);
  }
  const other = diff.files.filter((f) => f.kind === 'code' && !languageOf(f.path)).length;
  if (other > 0) {
    const files = other === 1 ? '1 code file is' : `${other} code files are`;
    notes.push(`${files} in another language, so only the counted facts and the AI reviewer cover ${other === 1 ? 'it' : 'them'}.`);
  }
  return notes;
}

function buildReview({ diff, facts, items, mode, seconds, now, hidden = [], cut = [], aiError = null, model = null, extraNotes = [] }) {
  items.sort(compareItems);
  items = dedupe(items);
  const counters = {};
  for (const item of items) {
    counters[item.area] = (counters[item.area] ?? 0) + 1;
    item.id = `${item.area}-${counters[item.area]}`;
  }

  return {
    mode,
    model,
    aiError,
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
        status: areaStatus(area, areaItems, facts, mode, cut),
        note: facts.notes[area.id] ?? null,
        items: areaItems,
      };
    }),
    hidden,
    checked: {
      files: diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind, additions: f.additions, deletions: f.deletions })),
      skipped: diff.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    },
    notes: [...limitNotes(diff, cut, now), ...extraNotes],
  };
}

/**
 * input: { sample: true | "demo" | "clean" } or { diff: "..." } or { url: "..." }
 * options.ai is the AI client (or null for basic mode); options.onStep(step) is
 * called with "fetch", "facts", "ai" and "verify" as each starts.
 */
export async function runReview(input = {}, { ai = null, github = null, claimCheck = true, onStep = () => {}, signal, clock = Date.now, rules = getRules() } = {}) {
  const started = clock();
  const raw = await readInput(input, { onStep, signal, github });

  onStep('facts');
  const diff = classifyDiff(raw);
  if (diff.files.length === 0 && diff.skipped.length === 0) {
    throw new ReviewError('nothing-to-review', `Nothing to review: this ${diff.source === 'paste' ? 'diff' : 'PR'} has no changed files.`);
  }
  if (diff.files.length === 0) {
    const names = diff.skipped.slice(0, 3).map((s) => s.path).join(', ') || 'nothing';
    throw new ReviewError('nothing-to-review', `Nothing to review: this ${diff.source === 'paste' ? 'diff' : 'PR'} only changes ${names}.`);
  }
  const facts = countFacts(diff);
  const hints = findHints(diff, rules).map((item) => attachProof(item, diff));
  let items = [...facts.items, ...hints];
  let mode = 'basic';
  let hidden = [];
  let cut = [];
  let aiError = null;
  const extraNotes = [];

  if (ai) {
    onStep('ai');
    const prompt = buildMessages({ diff, facts, hints, rules });
    cut = prompt.cut;
    try {
      if (prompt.reviewed.length === 0) {
        throw new AiError('too-big', 'This PR is too big for the AI reviewer to read, so this is the basic checklist.');
      }
      const reply = await askForReview(ai, prompt.messages, { schema: REPLY_SCHEMA, signal });
      onStep('verify');
      const checked = lineCheck(reply.items, diff);
      hidden = [
        ...checked.hidden,
        ...reply.incomplete.map((entry) => ({ ...entry, area: null, reason: HIDE_REASONS.incomplete, removedBy: 'line check' })),
      ];
      let aiItems = checked.items;
      if (claimCheck) {
        const claims = await checkClaims(ai, aiItems, diff, { signal });
        aiItems = claims.items;
        hidden.push(...claims.hidden);
        if (claims.failed) extraNotes.push('The second check (the claim check) didn\'t answer, so AI suggestions are marked unconfirmed.');
      } else {
        for (const item of aiItems) item.confidence = 'unconfirmed';
        extraNotes.push('The claim check is turned off (CLAIM_CHECK=off), so AI suggestions are marked unconfirmed.');
      }
      const capped = capAiItems(mergeItems(aiItems, items));
      items = capped.items;
      hidden.push(...capped.hidden);
      mode = 'ai';
    } catch (error) {
      if (signal?.aborted) throw error;
      // Any AI problem falls back to the basic checklist, so the person still gets something.
      aiError = error instanceof AiError ? error.message : 'The AI reviewer had an unexpected problem.';
      if (!(error instanceof AiError)) console.error(`AI review failed: ${error?.message ?? error}`);
      cut = [];
      hidden = [];
      extraNotes.length = 0;
    }
  }

  const now = clock();
  const seconds = Math.round((now - started) / 100) / 10;
  return buildReview({ diff, facts, items, mode, seconds, now, hidden, cut, aiError, extraNotes, model: mode === 'ai' ? ai.model : null });
}
