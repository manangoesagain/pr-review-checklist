// Labels each changed file by what it is (code, test, docs, config, dependency,
// generated, binary) from its path alone, and sets aside the files that should
// never reach the reviewer: lockfiles, generated files, binaries, and files
// GitHub sent without their changes.

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock',
  'go.sum', 'packages.lock.json', 'pubspec.lock', 'mix.lock', 'flake.lock', 'podfile.lock',
]);

const MANIFESTS = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'pipfile', 'setup.py', 'setup.cfg', 'go.mod',
  'cargo.toml', 'gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'pubspec.yaml', 'mix.exs', 'deno.json',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'psd', 'heic',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'whl',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'mp3', 'mp4', 'mov', 'wav', 'ogg', 'webm', 'avi',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'wasm', 'sqlite', 'sqlite3', 'db',
  'xlsx', 'xls', 'docx', 'pptx', 'keystore', 'p12',
]);

const DOC_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'rst', 'adoc', 'txt']);
const DOC_NAMES = new Set(['readme', 'changelog', 'license', 'licence', 'contributing', 'authors', 'notice', 'copying']);

const CONFIG_EXTENSIONS = new Set(['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'plist', 'editorconfig']);
const CONFIG_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc',
  '.node-version', '.python-version', '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc',
  'cmakelists.txt', 'vercel.json', 'netlify.toml',
]);

const TEST_PATTERNS = [
  /(^|\/)(test|tests|__tests__|__test__|spec|specs|e2e|cypress)\//i,
  /\.(test|spec|e2e)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go|rb|exs?|dart)$/i,
  /_spec\.rb$/i,
  /[a-z0-9](Tests?|Spec)\.(java|kt|cs|swift|scala|php)$/,
  /(^|\/)conftest\.py$/i,
];

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /(^|\/)(dist|build|out|coverage|vendor|node_modules|\.next|__pycache__)\//i,
  /\.snap$/i,
  /(^|\/)__snapshots__\//i,
  /\.(pb|pb\.gw)\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.generated\.[a-z0-9]+$/i,
  /\.g\.dart$/i,
];

const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist|defaults)$/i;
const MIGRATION = /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate|prisma\/migrations)\//i;

export const SKIP_REASONS = {
  lockfile: 'lockfile',
  generated: 'generated file',
  binary: 'binary file',
  noPatch: 'GitHub didn\'t send the changes for this file',
};

function baseName(path) {
  return path.split('/').at(-1);
}

function extensionOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Returns { kind, skip } for one path. `skip` is a reason, or null to review the file. */
export function classifyPath(path, { binary = false } = {}) {
  const name = baseName(path);
  const lower = name.toLowerCase();
  const ext = extensionOf(path);

  if (binary || BINARY_EXTENSIONS.has(ext)) return { kind: 'binary', skip: SKIP_REASONS.binary };
  if (LOCKFILES.has(lower)) return { kind: 'generated', skip: SKIP_REASONS.lockfile };
  if (GENERATED_PATTERNS.some((p) => p.test(path))) return { kind: 'generated', skip: SKIP_REASONS.generated };
  if (MANIFESTS.has(lower) || /^requirements([-_.][\w.-]+)?\.txt$/i.test(name) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path)) {
    return { kind: 'dependency', skip: null };
  }
  if (TEST_PATTERNS.some((p) => p.test(path))) return { kind: 'test', skip: null };
  if (/^\.env(\..+)?$/i.test(name)) return { kind: 'config', skip: null };
  if (CONFIG_NAMES.has(lower)) return { kind: 'config', skip: null };
  if (DOC_EXTENSIONS.has(ext) || DOC_NAMES.has(lower)) return { kind: 'docs', skip: null };
  if (/(^|\/)docs?\//i.test(path) && !ext) return { kind: 'docs', skip: null };
  if (CONFIG_EXTENSIONS.has(ext) || /^\.[\w-]+rc(\.\w+)?$/.test(lower) || /^tsconfig.*\.json$/.test(lower) || /(^|\/)\.github\//.test(path)) {
    return { kind: 'config', skip: null };
  }
  return { kind: 'code', skip: null };
}

/** True for a committed .env file (not .env.example), which may hold real keys. */
export function isSecretsFile(path) {
  const name = baseName(path);
  return /^\.env(\..+)?$/i.test(name) && !ENV_EXAMPLE.test(name);
}

export function isMigration(path) {
  return MIGRATION.test(path);
}

export function isReadme(path) {
  return /^readme(\.[a-z]+)?$/i.test(baseName(path));
}

/** Labels every file of a Diff and moves the ones that shouldn't be reviewed to `skipped`. */
export function classifyDiff(diff) {
  const kept = [];
  const skipped = [...diff.skipped];
  for (const file of diff.files) {
    const { kind, skip } = classifyPath(file.path, { binary: file.binary });
    file.kind = kind;
    const counts = { additions: file.additions, deletions: file.deletions };
    if (skip) {
      skipped.push({ path: file.path, reason: skip, ...counts });
    } else if (file.patchMissing) {
      skipped.push({ path: file.path, reason: SKIP_REASONS.noPatch, ...counts });
    } else {
      kept.push(file);
    }
  }
  return { ...diff, files: kept, skipped };
}
