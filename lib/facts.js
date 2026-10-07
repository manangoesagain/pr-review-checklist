// Counted facts: things plain code can say with certainty from the diff, like
// "4 code files changed, 0 test files". They work without an AI key, and they
// are handed to the AI reviewer as clues.

import { plural } from './areas.js';
import { isMigration, isReadme, isSecretsFile } from './classify.js';

const NOT_PACKAGES = new Set([
  'name', 'version', 'description', 'main', 'module', 'types', 'typings', 'license', 'private', 'type',
  'author', 'homepage', 'node', 'npm', 'yarn', 'pnpm', 'packagemanager', 'browser', 'bin', 'url', 'directory',
]);
const PACKAGE_VERSION = /^(?:[~^<>=]*\s*v?\d|\*$|x$|latest$|next$|workspace:|npm:|file:|link:|git\+|git:|github:|https?:)/i;
const SENSITIVE_PATH = /(auth|login|logout|session|passw|token|jwt|oauth|permission|crypto|secur)/i;

function fact(area, fields) {
  return {
    id: null,
    area,
    origin: 'fact',
    confidence: null,
    file: null,
    side: null,
    line: null,
    evidence: null,
    snippet: null,
    link: null,
    ...fields,
  };
}

function listPaths(paths, max = 3) {
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

function packageName(fileName, text) {
  if (fileName === 'package.json') {
    const match = /^\s*"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*"([^"]*)"/.exec(text);
    if (!match || NOT_PACKAGES.has(match[1].toLowerCase()) || !PACKAGE_VERSION.test(match[2].trim())) return null;
    return match[1];
  }
  if (/requirements.*\.txt$/.test(fileName)) {
    const line = text.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) return null;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:[<>=!~]=?|;|$)/.exec(line);
    return match ? match[1].toLowerCase() : null;
  }
  return null;
}

/** Package names added in a dependency file. A version bump (removed and re-added) doesn't count. */
export function newPackages(file) {
  const fileName = file.path.split('/').at(-1).toLowerCase();
  const added = [];
  const removed = new Set();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'ctx') continue;
      const name = packageName(fileName, line.text);
      if (!name) continue;
      if (line.type === 'add') added.push(name);
      else removed.add(name);
    }
  }
  return [...new Set(added)].filter((name) => !removed.has(name));
}

/**
 * Returns { stats, items, notes, clues }:
 * stats for the PR card, fact items for the checklist, a short note per area
 * (shown when the area has nothing to flag), and clue lines for the AI prompt.
 */
export function countFacts(diff) {
  const files = diff.files;
  const changedCode = files.filter((f) => f.kind === 'code' && f.status !== 'removed' && f.additions > 0);
  const testFiles = files.filter((f) => f.kind === 'test');
  const docsFiles = files.filter((f) => f.kind === 'docs');
  const readmeChanged = docsFiles.some((f) => isReadme(f.path));
  const sum = (list, key) => list.reduce((total, f) => total + (f[key] ?? 0), 0);

  const stats = {
    files: files.length + diff.skipped.length,
    reviewed: files.length,
    additions: sum(files, 'additions') + sum(diff.skipped, 'additions'),
    deletions: sum(files, 'deletions') + sum(diff.skipped, 'deletions'),
    codeFiles: changedCode.length,
    testFiles: testFiles.length,
    docsFiles: docsFiles.length,
    skipped: diff.skipped.length,
  };

  const items = [];
  const notes = {};

  // Tests
  if (changedCode.length > 0 && testFiles.length === 0) {
    const addedLines = sum(changedCode, 'additions');
    const hasNewFile = changedCode.some((f) => f.status === 'added');
    items.push(fact('tests', {
      key: 'no-tests',
      title: 'Code changed, but no tests did',
      severity: hasNewFile || addedLines >= 20 ? 'must-fix' : 'worth-asking',
      detail: `${plural(changedCode.length, 'code file')} changed, 0 test files`,
      why: 'Without a test, nothing warns you when this code breaks later.',
      fix: 'Add a test that runs the new code and checks its result.',
      comment: 'Could you add a test for this change? It would catch it if this breaks later.',
    }));
  } else if (testFiles.length > 0) {
    notes.tests = `${plural(testFiles.length, 'test file')} changed`;
  } else {
    notes.tests = 'No code changed';
  }

  // Breaking changes
  const deleted = files.filter((f) => f.kind === 'code' && f.status === 'removed').map((f) => f.path);
  if (deleted.length > 0) {
    items.push(fact('breaking', {
      key: 'deleted-files',
      title: deleted.length === 1 ? 'Code file deleted' : 'Code files deleted',
      severity: 'worth-asking',
      file: deleted.length === 1 ? deleted[0] : null,
      detail: `Deleted: ${listPaths(deleted)}`,
      why: 'Anything that still imports a deleted file will fail to load.',
      fix: 'Search the project for imports of it before merging.',
      comment: deleted.length === 1
        ? `Is anything still using ${deleted[0]}? This PR deletes it.`
        : 'Is anything still using the files this PR deletes?',
    }));
  }
  const moved = files.filter((f) => f.kind === 'code' && f.status === 'renamed' && f.oldPath);
  if (moved.length > 0) {
    items.push(fact('breaking', {
      key: 'renamed-files',
      title: moved.length === 1 ? 'Code file moved or renamed' : 'Code files moved or renamed',
      severity: 'worth-asking',
      file: moved.length === 1 ? moved[0].path : null,
      detail: listPaths(moved.map((f) => `${f.oldPath} → ${f.path}`), 2),
      why: 'Imports that still use the old path will break.',
      fix: 'Check that every import of the old path was updated.',
      comment: moved.length === 1
        ? `Were all imports of ${moved[0].oldPath} updated to the new path?`
        : 'Were all imports of the moved files updated to their new paths?',
    }));
  }
  const migrations = files.filter((f) => f.status === 'added' && isMigration(f.path)).map((f) => f.path);
  if (migrations.length > 0) {
    items.push(fact('breaking', {
      key: 'migration',
      title: 'Database migration added',
      severity: 'worth-asking',
      file: migrations.length === 1 ? migrations[0] : null,
      detail: listPaths(migrations),
      why: 'A migration changes live data, and a mistake there can be hard to undo.',
      fix: 'Try it on a copy of real data, and make sure it can be rolled back.',
      comment: 'Has this migration been tried on existing data, and can it be rolled back?',
    }));
  }

  // Docs
  notes.docs = readmeChanged ? 'README changed' : docsFiles.length > 0 ? `${plural(docsFiles.length, 'docs file')} changed` : 'No docs changed';

  // Security
  const secrets = files.filter((f) => f.status !== 'removed' && isSecretsFile(f.path)).map((f) => f.path);
  if (secrets.length > 0) {
    items.push(fact('security', {
      key: 'env-file',
      title: 'A .env file is in this PR',
      severity: 'must-fix',
      file: secrets[0],
      detail: listPaths(secrets),
      why: 'It usually holds real keys, and anyone who can read the repo can use them.',
      fix: 'Remove it from the PR, add it to .gitignore, and replace any keys it held.',
      comment: `This PR includes ${secrets[0]}. Could you take it out and replace any keys that were in it?`,
    }));
  }
  const packages = files.filter((f) => f.kind === 'dependency').flatMap((f) => newPackages(f).map((name) => ({ name, path: f.path })));
  if (packages.length > 0) {
    const names = [...new Set(packages.map((p) => p.name))];
    items.push(fact('security', {
      key: 'new-packages',
      title: names.length === 1 ? `New package added: ${names[0]}` : `${names.length} new packages added`,
      severity: 'good-to-know',
      file: packages[0].path,
      detail: `${packages[0].path}: ${listPaths(names, 5)}`,
      why: 'A package is code you didn\'t write, and some run scripts as soon as they\'re installed.',
      fix: 'Check each one is widely used, still maintained, and really needed.',
      comment: names.length === 1
        ? `What is ${names[0]} used for here? Is it well maintained?`
        : `What are the new packages (${listPaths(names, 3)}) used for? Are they well maintained?`,
    }));
  }
  const sensitive = files.filter((f) => f.kind === 'code' && SENSITIVE_PATH.test(f.path)).map((f) => f.path);
  if (sensitive.length > 0) {
    items.push(fact('security', {
      key: 'sensitive-code',
      title: 'Login or permission code changed',
      severity: 'good-to-know',
      file: sensitive.length === 1 ? sensitive[0] : null,
      detail: listPaths(sensitive),
      why: 'Small mistakes here can let the wrong person in.',
      fix: 'Read these changes slowly, and test a wrong password and an expired session.',
      comment: 'This touches login or permission code. Has it been tried with a wrong password and an expired session?',
    }));
  }

  const clues = [
    `${plural(changedCode.length, 'code file')} changed, ${plural(testFiles.length, 'test file')} changed.`,
    readmeChanged ? 'The README was changed in this PR.' : 'The README was not changed in this PR.',
    ...items.filter((i) => i.area !== 'tests').map((i) => `${i.title} (${i.detail}).`),
  ];

  return { stats, items, notes, clues };
}
