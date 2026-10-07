// Reads unified diffs into the Diff model: files → hunks → lines, where every
// line knows its type (add, del, ctx) and its line number in the old and new file.
// Two sources end up in the same shape: a pasted `git diff`, and the per-file
// patches GitHub sends for a pull request.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export class DiffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiffError';
    this.code = code;
  }
}

// Accepts Windows (\r\n) and old Mac (\r) line endings as well as Unix ones.
function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// Reads one hunk starting at its "@@" line. The counts in the header say exactly
// how many lines belong to it, which is what stops a deleted line that happens
// to start with "-- " from being mistaken for a new file header.
function readHunk(lines, start) {
  const match = HUNK_HEADER.exec(lines[start]);
  const hunk = {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5].trim(),
    lines: [],
  };
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let oldLeft = hunk.oldCount;
  let newLeft = hunk.newCount;
  let i = start + 1;

  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const raw = lines[i];
    const mark = raw[0];
    if (mark === '\\') {
      // "\ No newline at end of file" describes the line above it.
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
    } else if (mark === '+' && newLeft > 0) {
      hunk.lines.push({ type: 'add', old: null, new: newNo++, text: raw.slice(1) });
      newLeft--;
    } else if (mark === '-' && oldLeft > 0) {
      hunk.lines.push({ type: 'del', old: oldNo++, new: null, text: raw.slice(1) });
      oldLeft--;
    } else if ((mark === ' ' || raw === '') && oldLeft > 0 && newLeft > 0) {
      // Some editors strip the single space from empty context lines.
      hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text: raw.slice(1) });
      oldLeft--;
      newLeft--;
    } else {
      break; // The counts were wrong (a hand-edited diff); keep what was read.
    }
    i++;
  }
  while (i < lines.length && lines[i].startsWith('\\')) {
    const last = hunk.lines.at(-1);
    if (last) last.noNewline = true;
    i++;
  }
  return { hunk, next: i };
}

/** Reads a patch that holds only hunks, like the `patch` field GitHub sends per file. */
export function parsePatch(patch) {
  const lines = splitLines(patch ?? '');
  const hunks = [];
  let i = 0;
  while (i < lines.length) {
    if (HUNK_HEADER.test(lines[i])) {
      const { hunk, next } = readHunk(lines, i);
      hunks.push(hunk);
      i = next;
    } else {
      i++;
    }
  }
  return hunks;
}

// "a/src/x.ts", "\"a/my file.ts\"" or "src/x.ts\t2024-01-01 10:00" → "src/x.ts"
function cleanPath(raw) {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t');
  }
  value = value.split('\t')[0];
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

// "diff --git a/x b/y" → { oldPath, newPath }. Only used until ---/+++ or rename lines say better.
function pathsFromGitHeader(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^"(.+?)" "(.+?)"$/);
  if (quoted) return { oldPath: cleanPath(`"${quoted[1]}"`), newPath: cleanPath(`"${quoted[2]}"`) };
  const half = rest.match(/^a\/(.+) b\/(.+)$/);
  if (half && half[1] === half[2]) return { oldPath: half[1], newPath: half[2] };
  const split = rest.indexOf(' b/');
  if (rest.startsWith('a/') && split > 0) return { oldPath: rest.slice(2, split), newPath: rest.slice(split + 3) };
  return { oldPath: null, newPath: null };
}

function newFile() {
  return { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [] };
}

function finishFile(file) {
  if (file.oldPath === null && file.newPath === null) return null;
  let status = file.status;
  if (file.newPath === null) status = 'removed';
  else if (file.oldPath === null) status = 'added';
  else if (status === 'modified' && file.oldPath !== file.newPath) status = 'renamed';
  return buildFile({
    path: file.newPath ?? file.oldPath,
    oldPath: status === 'renamed' ? file.oldPath : null,
    status,
    binary: file.binary,
    hunks: file.hunks,
  });
}

function buildFile({ path, oldPath = null, status, binary = false, hunks, patchMissing = false }) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      if (line.type === 'del') deletions++;
    }
  }
  return { path, oldPath, status, kind: null, binary, patchMissing, additions, deletions, hunks };
}

/** Reads pasted text: the output of `git diff`, or classic `diff -u` output. */
export function parseDiffText(text) {
  const lines = splitLines(text);
  const files = [];
  let file = null;
  let i = 0;

  const close = () => {
    if (file) {
      const done = finishFile(file);
      if (done) files.push(done);
    }
    file = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      close();
      file = newFile();
      Object.assign(file, pathsFromGitHeader(line));
      i++;
      continue;
    }

    // A file without a "diff --git" header (plain diff -u), or the ---/+++ pair of a git file.
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!file || file.hunks.length > 0 || file.sawMarkers) {
        close();
        file = newFile();
      }
      file.oldPath = cleanPath(line.slice(4));
      file.newPath = cleanPath(lines[i + 1].slice(4));
      file.sawMarkers = true;
      i += 2;
      continue;
    }

    if (HUNK_HEADER.test(line)) {
      if (!file) {
        file = newFile(); // A bare hunk with no file header at all.
        file.oldPath = file.newPath = 'pasted.diff';
      }
      const { hunk, next } = readHunk(lines, i);
      file.hunks.push(hunk);
      i = next;
      continue;
    }

    if (file) {
      if (line.startsWith('new file mode')) file.oldPath = null;
      else if (line.startsWith('deleted file mode')) file.newPath = null;
      else if (line.startsWith('rename from ')) { file.oldPath = line.slice(12).trim(); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { file.newPath = line.slice(10).trim(); file.status = 'renamed'; }
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
    }
    i++;
  }
  close();
  return files;
}

/** A pasted diff → the Diff model. Throws a DiffError the page can show as is. */
export function diffFromText(text) {
  const files = parseDiffText(text);
  const hasChanges = files.some((f) => f.hunks.length > 0 || f.binary || f.status !== 'modified');
  if (!hasChanges) {
    throw new DiffError('not-a-diff', 'That doesn\'t look like a diff. Run git diff and paste the output.');
  }
  return {
    source: 'paste',
    repo: null,
    number: null,
    title: null,
    body: '',
    url: null,
    headSha: null,
    baseSha: null,
    readme: '',
    files,
    skipped: [],
  };
}

/** GitHub's pull request and files responses (plus README text) → the Diff model. */
export function diffFromGitHub({ pr, files, readme = '' }) {
  return {
    source: 'github',
    repo: pr.base?.repo?.full_name ?? null,
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    url: pr.html_url ?? null,
    headSha: pr.head?.sha ?? null,
    baseSha: pr.base?.sha ?? null,
    readme: readme ?? '',
    changedFiles: pr.changed_files ?? null,
    files: files.map((f) => buildFile({
      path: f.filename,
      oldPath: f.status === 'renamed' ? f.previous_filename ?? null : null,
      status: f.status,
      hunks: typeof f.patch === 'string' ? parsePatch(f.patch) : [],
      // GitHub leaves out `patch` for binary files and very large diffs.
      patchMissing: typeof f.patch !== 'string' && f.changes > 0,
    })),
    skipped: [],
  };
}

/** Finds a line in a file by side ("R" = new file, "L" = old file) and number. */
export function findLine(file, side, number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === 'R' && line.new === number) return { hunk, line };
      if (side === 'L' && line.type === 'del' && line.old === number) return { hunk, line };
    }
  }
  return null;
}

/** "R15" for added and unchanged lines, "L41" for deleted lines. */
export function refOf(line) {
  return line.type === 'del' ? `L${line.old}` : `R${line.new}`;
}
