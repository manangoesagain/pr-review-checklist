// Builds the bookshop demo repo: a main branch plus two pull request branches.
// Commit dates and author are fixed, so the commit ids come out the same on every
// computer, and the saved samples point at the same commits as the real repo.
//
//   node demo/build-demo.js <folder>   create the demo repo in a new folder, ready to push
//   node demo/build-demo.js --samples  rebuild samples/demo-pr.json and samples/clean-pr.json
//   node demo/build-demo.js --check    fail if the saved samples no longer match the demo files

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/env.js';

const demoFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bookshop-demo');
const samplesFolder = path.join(demoFolder, '..', '..', 'samples');

export const DEMO_REPO = 'manangoesagain/bookshop-demo';

export const PULL_REQUESTS = [
  {
    number: 1,
    branch: 'order-search',
    sample: 'demo-pr.json',
    title: 'Add order search',
    body: 'Adds a search endpoint for orders, makes the orders query simpler to read, and returns the user\'s full name.',
    commit: 'Add order search',
    date: '2026-10-07T11:00:00Z',
  },
  {
    number: 2,
    branch: 'isbn-lookup',
    sample: 'clean-pr.json',
    title: 'Look up a book by ISBN',
    body: 'Adds GET /v1/books/:isbn to look up one book. The ISBN is checked before the query runs, the query uses a parameter, and the README lists the new endpoint.',
    commit: 'Look up a book by ISBN',
    date: '2026-10-07T12:00:00Z',
  },
];

const AUTHOR = { name: 'Bookshop Demo', email: 'demo@example.com' };

function git(cwd, args, date) {
  const env = { ...process.env };
  if (date) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_COMMITTER_DATE: date,
    });
  }
  const settings = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false',
    '-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`];
  return execFileSync('git', [...settings, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

// Copies a branch's files into the repo, always with Unix line endings, so a
// Windows checkout of this project still produces the same commits.
function copyFiles(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      copyFiles(source, target);
    } else {
      fs.writeFileSync(target, fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n'));
    }
  }
}

export function buildDemoRepo(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`${target} is not empty. Pick a new folder.`);
  }
  fs.mkdirSync(target, { recursive: true });
  git(target, ['init', '--quiet']);
  git(target, ['checkout', '--quiet', '-b', 'main']);
  copyFiles(path.join(demoFolder, 'main'), target);
  git(target, ['add', '--all']);
  git(target, ['commit', '--quiet', '--no-verify', '-m', 'Start the bookshop API'], '2026-10-07T10:00:00Z');

  for (const pr of PULL_REQUESTS) {
    git(target, ['checkout', '--quiet', '-b', pr.branch, 'main']);
    copyFiles(path.join(demoFolder, pr.branch), target);
    git(target, ['add', '--all']);
    git(target, ['commit', '--quiet', '--no-verify', '-m', pr.commit], pr.date);
  }
  git(target, ['checkout', '--quiet', 'main']);
  return target;
}

const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied' };

// The same shape GitHub's API returns for GET /pulls/{n} and GET /pulls/{n}/files,
// limited to the fields this app reads.
export function sampleFromRepo(repo, pr) {
  const range = `main...${pr.branch}`;
  const headSha = git(repo, ['rev-parse', pr.branch]).trim();
  const baseSha = git(repo, ['rev-parse', 'main']).trim();
  const numstat = git(repo, ['diff', '--numstat', '-M', range]).trim().split('\n');
  const statuses = git(repo, ['diff', '--name-status', '-M', range]).trim().split('\n');

  const files = statuses.map((line, index) => {
    const [code, ...paths] = line.split('\t');
    const filename = paths.at(-1);
    const [added, deleted] = numstat[index].split('\t');
    const fullDiff = git(repo, ['diff', '-M', range, '--', ...paths]);
    const patch = fullDiff.slice(fullDiff.indexOf('@@')).replace(/\n$/, '');
    const file = {
      sha: code[0] === 'D' ? null : git(repo, ['rev-parse', `${pr.branch}:${filename}`]).trim(),
      filename,
      status: STATUS[code[0]] ?? 'modified',
      additions: Number(added),
      deletions: Number(deleted),
      changes: Number(added) + Number(deleted),
      patch,
    };
    if (code[0] === 'R') file.previous_filename = paths[0];
    return file;
  });

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const repoInfo = { full_name: DEMO_REPO, html_url: `https://github.com/${DEMO_REPO}` };
  return {
    about: `Saved GitHub API responses for ${DEMO_REPO} pull request #${pr.number}, built by demo/build-demo.js. Used by "Try a sample" and the tests, so they work offline.`,
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: 'open',
      html_url: `https://github.com/${DEMO_REPO}/pull/${pr.number}`,
      user: { login: DEMO_REPO.split('/')[0] },
      head: { ref: pr.branch, sha: headSha, repo: repoInfo },
      base: { ref: 'main', sha: baseSha, repo: repoInfo },
      additions,
      deletions,
      changed_files: files.length,
    },
    files,
    readme: git(repo, ['show', `${pr.branch}:README.md`]),
  };
}

function buildSamples() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshop-demo-'));
  try {
    buildDemoRepo(path.join(temp, 'repo'));
    return PULL_REQUESTS.map((pr) => ({ pr, sample: sampleFromRepo(path.join(temp, 'repo'), pr) }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Rebuilds the demo repo in a temporary folder and compares its diffs with the saved samples. */
export function checkSamples() {
  return buildSamples().map(({ pr, sample }) => {
    const saved = fs.readFileSync(path.join(samplesFolder, pr.sample), 'utf8').replace(/\r\n/g, '\n');
    return { file: pr.sample, matches: saved === JSON.stringify(sample, null, 2) + '\n', headSha: sample.pr.head.sha };
  });
}

function main(argv) {
  if (argv[0] === '--samples') {
    for (const { pr, sample } of buildSamples()) {
      fs.writeFileSync(path.join(samplesFolder, pr.sample), JSON.stringify(sample, null, 2) + '\n');
      console.log(`Wrote samples/${pr.sample} (PR #${pr.number}, ${sample.files.length} files, head ${sample.pr.head.sha.slice(0, 7)})`);
    }
    return;
  }
  if (argv[0] === '--check') {
    const results = checkSamples();
    for (const { file, matches } of results) {
      console.log(`samples/${file}: ${matches ? 'matches the demo repo' : 'OUT OF DATE, run: node demo/build-demo.js --samples'}`);
    }
    process.exitCode = results.every((r) => r.matches) ? 0 : 1;
    return;
  }
  if (!argv[0]) {
    console.log('Usage: node demo/build-demo.js <new folder>   (or --samples, --check)');
    process.exitCode = 1;
    return;
  }
  const target = path.resolve(argv[0]);
  buildDemoRepo(target);
  console.log(`Demo repo created in ${target}`);
  console.log('Branches: main, ' + PULL_REQUESTS.map((pr) => pr.branch).join(', '));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
