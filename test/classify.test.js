import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff, classifyPath, isSecretsFile } from '../lib/classify.js';

const kind = (path) => classifyPath(path).kind;

test('labels files by path', () => {
  assert.equal(kind('src/search.ts'), 'code');
  assert.equal(kind('app/models/user.py'), 'code');
  assert.equal(kind('test/users.test.ts'), 'test');
  assert.equal(kind('src/__tests__/cart.js'), 'test');
  assert.equal(kind('src/cart.spec.tsx'), 'test');
  assert.equal(kind('tests/test_cart.py'), 'test');
  assert.equal(kind('pkg/cart_test.go'), 'test');
  assert.equal(kind('README.md'), 'docs');
  assert.equal(kind('docs/setup.mdx'), 'docs');
  assert.equal(kind('LICENSE'), 'docs');
  assert.equal(kind('package.json'), 'dependency');
  assert.equal(kind('requirements-dev.txt'), 'dependency');
  assert.equal(kind('tsconfig.json'), 'config');
  assert.equal(kind('.github/workflows/ci.yml'), 'config');
  assert.equal(kind('Dockerfile'), 'config');
  assert.equal(kind('.env'), 'config');
});

test('lockfiles, generated files and binaries are skipped with a reason', () => {
  assert.deepEqual(classifyPath('package-lock.json'), { kind: 'generated', skip: 'lockfile' });
  assert.deepEqual(classifyPath('web/yarn.lock'), { kind: 'generated', skip: 'lockfile' });
  assert.deepEqual(classifyPath('dist/app.min.js'), { kind: 'generated', skip: 'generated file' });
  assert.deepEqual(classifyPath('img/logo.png'), { kind: 'binary', skip: 'binary file' });
  assert.deepEqual(classifyPath('data.bin', { binary: true }), { kind: 'binary', skip: 'binary file' });
});

test('only real .env files count as secrets files', () => {
  assert.equal(isSecretsFile('.env'), true);
  assert.equal(isSecretsFile('config/.env.production'), true);
  assert.equal(isSecretsFile('.env.example'), false);
  assert.equal(isSecretsFile('src/env.ts'), false);
});

test('classifyDiff moves skipped files out and keeps their line counts', () => {
  const file = (path, extra = {}) => ({ path, status: 'modified', binary: false, patchMissing: false, additions: 2, deletions: 1, hunks: [], ...extra });
  const diff = classifyDiff({
    files: [file('src/a.ts'), file('package-lock.json'), file('big.js', { patchMissing: true })],
    skipped: [],
  });
  assert.deepEqual(diff.files.map((f) => [f.path, f.kind]), [['src/a.ts', 'code']]);
  assert.deepEqual(diff.skipped, [
    { path: 'package-lock.json', reason: 'lockfile', additions: 2, deletions: 1 },
    { path: 'big.js', reason: 'GitHub didn\'t send the changes for this file', additions: 2, deletions: 1 },
  ]);
});
