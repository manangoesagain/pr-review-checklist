// Pattern hints: cheap checks for known risky code, driven by rules/*.json.
// They only look at lines this PR adds or removes, they can be wrong (a pattern
// doesn't understand the code), and they are handed to the AI as clues.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_IDS } from './areas.js';
import { isReadme } from './classify.js';

const rulesFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules');

const LANGUAGES = {
  js: new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro']),
  py: new Set(['py', 'pyi']),
};
const LOOP_START = /^\s*(for|while)\b|^\s*do\s*\{|\.(forEach|map|flatMap|reduce|filter|some|every)\s*\(\s*(async\s*)?(\(|[\w$]+\s*=>|function)/;
const HANDLER_START = /\(\s*(req|request)\b[^)]*,\s*(res|response|reply)\b|\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(|@\w+\.(route|get|post|put|patch|delete)\s*\(|\bdef\s+\w+\s*\(\s*request\b/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;
const MAX_PER_RULE = 3;
// Longer lines (minified or generated code) are skipped: some patterns slow down a lot
// on very long lines, and a person doesn't review those lines by eye anyway.
export const MAX_HINT_LINE = 1_000;

export function languageOf(filePath) {
  const ext = filePath.split('.').at(-1).toLowerCase();
  for (const [language, extensions] of Object.entries(LANGUAGES)) {
    if (extensions.has(ext)) return language;
  }
  return null;
}

/** Reads and checks every rules/*.json file. Throws a clear message for a broken pattern. */
export function loadRules(folder = rulesFolder) {
  return AREA_IDS.map((area) => {
    const file = path.join(folder, `${area}.json`);
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hints = (rules.hints ?? []).map((hint) => {
      const patterns = {};
      for (const [language, source] of Object.entries(hint.patterns ?? {})) {
        try {
          patterns[language] = new RegExp(source, hint.flags ?? '');
        } catch (error) {
          throw new Error(`rules/${area}.json, hint "${hint.id}" (${language}): ${error.message}`);
        }
      }
      return {
        ...hint,
        area,
        match: hint.match ?? 'added',
        kinds: new Set(hint.kinds ?? ['code']),
        patterns,
        unless: hint.unless ? new RegExp(hint.unless, 'i') : null,
        ignore: new Set(hint.ignore ?? []),
      };
    });
    return { area, questions: rules.questions ?? [], hints };
  });
}

let defaultRules = null;
export function getRules() {
  defaultRules ??= loadRules();
  return defaultRules;
}

function patternFor(hint, file) {
  const language = languageOf(file.path);
  return (language && hint.patterns[language]) || hint.patterns.any || null;
}

function firstCapture(match) {
  const value = match?.slice(1).find((group) => group !== undefined);
  return value === undefined ? '' : value.trim().slice(0, 60);
}

function fill(text, capture) {
  return String(text ?? '').replaceAll('{1}', capture);
}

function indentOf(text) {
  const spaces = /^[ \t]*/.exec(text)[0];
  return spaces.replace(/\t/g, '    ').length;
}

// Lines of the new file in this hunk (added and unchanged), in order.
function newSide(hunk) {
  return hunk.lines.filter((line) => line.type !== 'del');
}

// True when the line sits inside a loop that starts a few lines above it.
function insideLoop(hunk, line) {
  const lines = newSide(hunk);
  let index = lines.indexOf(line);
  let indent = indentOf(line.text);
  let levels = 0;
  for (let scanned = 0; index > 0 && scanned < 15 && levels < 3; scanned++) {
    const above = lines[--index];
    if (!above.text.trim()) continue;
    const aboveIndent = indentOf(above.text);
    if (aboveIndent < indent) {
      if (LOOP_START.test(above.text)) return true;
      indent = aboveIndent;
      levels++;
      if (aboveIndent === 0) break;
    }
  }
  return false;
}

function insideHandler(hunk, line) {
  const lines = newSide(hunk);
  const index = lines.indexOf(line);
  return lines.slice(Math.max(0, index - 30), index + 1).some((above) => HANDLER_START.test(above.text));
}

// Top-level keys of a one-line object literal: "{ user: { id }, name }" → ["name", "user"].
export function objectKeys(text) {
  const keys = new Set();
  let depth = 0;
  let quote = null;
  let start = 0;
  const take = (part) => {
    const match = /^\s*(?:\.\.\.\s*)?["']?([A-Za-z_$][\w$]*)["']?\s*(?::|$)/.exec(part);
    if (match) keys.add(part.trim().startsWith('...') ? `...${match[1]}` : match[1]);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('{[('.includes(ch)) {
      depth++;
      if (depth === 1) start = i + 1;
    } else if ('}])'.includes(ch)) {
      if (depth === 1) take(text.slice(start, i));
      depth--;
    } else if (ch === ',' && depth === 1) {
      take(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...keys].sort();
}

const FUNCTION_NAME = /\bfunction\*?\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/;

// The name of the closest function that starts above this line in the hunk.
function functionAbove(hunk, line) {
  const lines = newSide(hunk);
  for (let index = lines.indexOf(line) - 1; index >= 0; index--) {
    const match = FUNCTION_NAME.exec(lines[index].text);
    const name = match?.slice(1).find(Boolean);
    if (name && !['if', 'for', 'while', 'switch', 'catch'].includes(name)) return name;
  }
  return null;
}

function makeHint(hint, file, line, capture, extra = {}) {
  return {
    id: null,
    area: hint.area,
    origin: 'hint',
    confidence: null,
    key: hint.id,
    title: fill(hint.title, capture),
    severity: hint.severity,
    file: file.path,
    side: line.type === 'del' ? 'L' : 'R',
    line: line.type === 'del' ? line.old : line.new,
    evidence: line.text.trim(),
    why: fill(hint.why, capture),
    fix: fill(hint.fix, capture),
    comment: fill(hint.comment, capture),
    detail: null,
    snippet: null,
    link: null,
    ...extra,
  };
}

function* changedLines(file, type) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === type && line.text.length <= MAX_HINT_LINE) yield { hunk, line };
    }
  }
}

// Names (exports, routes, settings) captured from every added or removed line of the diff.
function capturedNames(diff, hint, type) {
  const names = new Set();
  for (const file of diff.files) {
    const pattern = patternFor(hint, file);
    if (!pattern) continue;
    for (const { line } of changedLines(file, type)) {
      const name = firstCapture(pattern.exec(line.text));
      if (name) names.add(name);
    }
  }
  return names;
}

function documentationText(diff) {
  const parts = [diff.readme ?? ''];
  for (const file of diff.files) {
    if (file.kind === 'docs' || ENV_EXAMPLE.test(file.path)) {
      for (const { line } of changedLines(file, 'add')) parts.push(line.text);
    }
  }
  return parts.join('\n');
}

function findForHint(hint, diff) {
  const found = [];
  const files = diff.files.filter((file) => hint.kinds.has(file.kind) && patternFor(hint, file));

  if (hint.match === 'removed-name') {
    const stillThere = capturedNames(diff, hint, 'add');
    for (const file of files) {
      const pattern = patternFor(hint, file);
      for (const { line } of changedLines(file, 'del')) {
        const name = firstCapture(pattern.exec(line.text));
        if (name && !stillThere.has(name)) found.push(makeHint(hint, file, line, name));
      }
    }
    return found;
  }

  if (hint.match === 'changed-signature') {
    for (const file of files) {
      const pattern = patternFor(hint, file);
      const before = new Map();
      for (const { line } of changedLines(file, 'del')) {
        const match = pattern.exec(line.text);
        if (match) before.set(match[1], match[2].replace(/\s+/g, ''));
      }
      for (const { line } of changedLines(file, 'add')) {
        const match = pattern.exec(line.text);
        if (match && before.has(match[1]) && before.get(match[1]) !== match[2].replace(/\s+/g, '')) {
          found.push(makeHint(hint, file, line, match[1]));
        }
      }
    }
    return found;
  }

  if (hint.match === 'changed-return-shape') {
    // A returned object whose fields changed, removed and added in the same hunk.
    for (const file of files) {
      const pattern = patternFor(hint, file);
      for (const hunk of file.hunks) {
        const shape = (line) => {
          if (line.text.length > MAX_HINT_LINE) return null;
          const match = pattern.exec(line.text);
          return match ? objectKeys(match[1]) : null;
        };
        const before = hunk.lines.filter((l) => l.type === 'del').map(shape).filter(Boolean);
        const after = hunk.lines.filter((l) => l.type === 'add').map((l) => ({ line: l, keys: shape(l) })).filter((a) => a.keys);
        after.forEach(({ line, keys }, i) => {
          const old = before[i];
          if (!old || old.join() === keys.join()) return;
          const name = functionAbove(hunk, line) ?? 'this function';
          const gone = old.filter((k) => !keys.includes(k));
          const detail = gone.length ? `Fields no longer returned: ${gone.join(', ')}` : null;
          found.push(makeHint(hint, file, line, name, { detail }));
        });
      }
    }
    return found;
  }

  if (hint.match === 'removed-assertions') {
    for (const file of files) {
      const pattern = patternFor(hint, file);
      const removed = [...changedLines(file, 'del')].filter(({ line }) => pattern.test(line.text));
      const added = [...changedLines(file, 'add')].filter(({ line }) => pattern.test(line.text));
      if (removed.length > added.length) {
        const fewer = removed.length - added.length;
        found.push(makeHint(hint, file, removed[0].line, '', { detail: `${fewer} fewer ${fewer === 1 ? 'check' : 'checks'} in this file` }));
      }
    }
    return found;
  }

  if (hint.match === 'new-name-undocumented') {
    const existed = capturedNames(diff, hint, 'del');
    const docs = documentationText(diff);
    const readmeKnown = Boolean(diff.readme) || diff.files.some((f) => isReadme(f.path));
    for (const file of files) {
      const pattern = patternFor(hint, file);
      for (const { line } of changedLines(file, 'add')) {
        const name = firstCapture(pattern.exec(line.text));
        if (!name || existed.has(name) || hint.ignore.has(name) || docs.includes(name)) continue;
        // Without the README we can't say what it lists, only that no docs changed.
        if (!readmeKnown && diff.files.some((f) => f.kind === 'docs')) continue;
        const title = readmeKnown ? hint.title : hint.titleWithoutReadme ?? hint.title;
        found.push(makeHint({ ...hint, title }, file, line, name));
      }
    }
    return found;
  }

  for (const file of files) {
    const pattern = patternFor(hint, file);
    for (const { hunk, line } of changedLines(file, 'add')) {
      const match = pattern.exec(line.text);
      if (!match || (hint.unless && hint.unless.test(line.text))) continue;
      if (hint.match === 'in-loop' && !insideLoop(hunk, line)) continue;
      if (hint.match === 'in-handler' && !insideHandler(hunk, line)) continue;
      found.push(makeHint(hint, file, line, firstCapture(match)));
    }
  }
  return found;
}

/** Every pattern hint for a classified Diff, at most 3 per rule (the first one says how many more). */
export function findHints(diff, rules = getRules()) {
  const items = [];
  for (const area of rules) {
    for (const hint of area.hints) {
      const found = findForHint(hint, diff);
      if (found.length > MAX_PER_RULE) {
        found[0].detail = `Found on ${found.length} lines in this PR; the first ${MAX_PER_RULE} are listed.`;
      }
      items.push(...found.slice(0, MAX_PER_RULE));
    }
  }
  return items;
}
