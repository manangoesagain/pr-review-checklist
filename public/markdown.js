// Turns a Review into GitHub task-list Markdown for Copy Markdown and Download .md.
// Pasted into a PR comment, the boxes can be ticked and each file:line opens that
// line on GitHub. It lives in public/ so the page and the tests use the same file.

export const SEVERITY_LABELS = { 'must-fix': 'Must fix', 'worth-asking': 'Worth asking', 'good-to-know': 'Good to know' };
const SEVERITY_ORDER = ['must-fix', 'worth-asking', 'good-to-know'];
const AREA_ORDER = ['security', 'tests', 'breaking', 'docs', 'performance'];

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "4 AI suggestions hidden: 3 couldn't be checked against the code, 1 rejected by the second check", or null. */
export function hiddenSummary(hidden = []) {
  if (hidden.length === 0) return null;
  const counts = { line: 0, claim: 0, limit: 0 };
  for (const entry of hidden) {
    counts[entry.removedBy === 'claim check' ? 'claim' : entry.removedBy === 'limit' ? 'limit' : 'line']++;
  }
  const parts = [
    counts.line ? `${counts.line} couldn't be checked against the code` : null,
    counts.claim ? `${counts.claim} rejected by the second check` : null,
    counts.limit ? `${counts.limit} over the limit` : null,
  ].filter(Boolean);
  return `${plural(hidden.length, 'AI suggestion')} hidden: ${parts.join(', ')}`;
}

// Plain text: escapes only what could turn a title into emphasis, a link, HTML or
// strikethrough, so the raw Markdown stays readable (snake_case and a-b stay as is).
function escapePlain(text) {
  return text
    .replace(/[\\`*[\]<~]/g, '\\$&')
    .replace(/(?<!\w)_+|_+(?!\w)/g, (run) => run.replace(/_/g, '\\_'))
    .replace(/&(?=#?\w+;)/g, '&amp;');
}

// Code goes in a backtick span long enough to hold any backticks inside it.
function codeSpan(code) {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

const MENTION = /(?<![\w`])(@[A-Za-z0-9][\w-]*(?:[./][\w-]+)*)/;

/** A comment to paste on GitHub as is: every @name becomes code, so pasting it doesn't notify anyone. */
export function quietMentions(text) {
  return String(text ?? '').split(MENTION).map((piece, i) => (i % 2 === 1 ? codeSpan(piece) : piece)).join('');
}

/**
 * One line of item text, safe to paste into GitHub. Code the AI wrapped in backticks
 * stays code, and an @name becomes code so pasting it doesn't notify anyone.
 */
export function inlineText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const prose = (part) => part.split(MENTION).map((piece, i) => (i % 2 === 1 ? codeSpan(piece) : escapePlain(piece))).join('');
  let out = '';
  let rest = text;
  // A run of N backticks opens code that ends at the next run of exactly N backticks.
  for (let match = /`+/.exec(rest); match; match = /`+/.exec(rest)) {
    const fence = match[0];
    const after = rest.slice(match.index + fence.length);
    const close = new RegExp(`(?<!\`)${fence}(?!\`)`).exec(after);
    if (!close) {
      out += prose(rest.slice(0, match.index + fence.length));
      rest = after;
      continue;
    }
    const code = after.slice(0, close.index);
    out += prose(rest.slice(0, match.index)) + (code.trim() ? codeSpan(code.trim()) : escapePlain(fence + code + fence));
    rest = after.slice(close.index + fence.length);
  }
  out += prose(rest);
  // A line can't start a heading, list, quote or rule inside the checklist.
  return out.replace(/^[#>=+-]/, '\\$&').replace(/^(\d+)([.)])/, '$1\\$2');
}

function safeLink(url) {
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) return null;
  // encodeURIComponent leaves ( and ) alone, and a ) would end the Markdown link early.
  return url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function refMarkdown(item) {
  if (!item.line || !item.file) return item.detail ? inlineText(item.detail) : item.file ? codeSpan(item.file) : '';
  const label = `${item.file}:${item.line}`.replace(/[\\[\]*_`<>]/g, '\\$&');
  const link = safeLink(item.link);
  const ref = link ? `[${label}](${link})` : codeSpan(`${item.file}:${item.line}`);
  return item.side === 'L' ? `${ref}, a removed line` : ref;
}

function itemMarkdown(item, done) {
  const severity = SEVERITY_LABELS[item.severity] ?? item.severity;
  const unconfirmed = item.origin === 'ai' && item.confidence === 'unconfirmed' ? ' _(not confirmed)_' : '';
  const ref = refMarkdown(item);
  const lines = [`- [${done ? 'x' : ' '}] **${severity}: ${inlineText(item.title)}**${ref ? ` (${ref})` : ''}${unconfirmed}`];
  if (item.line && item.detail) lines.push(`  ${inlineText(item.detail)}`);
  if (item.why) lines.push(`  ${inlineText(item.why)}`);
  if (item.fix) lines.push(`  Fix: ${inlineText(item.fix)}`);
  return lines.join('\n');
}

function summaryLine(review, items) {
  const { stats } = review;
  const counts = SEVERITY_ORDER
    .map((severity) => [severity, items.filter((item) => item.severity === severity).length])
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${SEVERITY_LABELS[severity].toLowerCase()}`);
  const areaNames = (status) => review.areas.filter((a) => a.status === status).map((a, i) => (i === 0 ? a.name : a.name.toLowerCase()));
  const clear = areaNames('clear');
  const partial = areaNames('partial');
  const unchecked = areaNames('unchecked');
  const sentences = [
    `**${plural(stats.files, 'file')}, +${stats.additions} / -${stats.deletions}.**`,
    counts.length ? `${capitalize(listWords(counts))}.` : 'No problems found.',
  ];
  if (clear.length) sentences.push(`${listWords(clear)} ${clear.length === 1 ? 'looks' : 'look'} good.`);
  if (partial.length) sentences.push(`Nothing found in the part the AI reviewer read: ${listWords(partial).toLowerCase()}.`);
  if (unchecked.length) sentences.push(`Not checked without the AI reviewer: ${listWords(unchecked).toLowerCase()}.`);
  return sentences.join(' ');
}

/**
 * The whole checklist as Markdown. `done` is a Set of item ids the person ticked,
 * so the pasted list keeps their ticks. Hidden suggestions are left out and only counted.
 */
export function reviewMarkdown(review, { done = new Set() } = {}) {
  const heading = review.pr
    ? `### Review checklist: ${inlineText(review.pr.title || 'Untitled pull request')} (#${Number(review.pr.number)})`
    : '### Review checklist: pasted diff';
  const items = review.areas.flatMap((area) => area.items);
  const blocks = [heading, summaryLine(review, items)];
  const areas = [...review.areas].sort((a, b) => AREA_ORDER.indexOf(a.id) - AREA_ORDER.indexOf(b.id));
  for (const area of areas) {
    if (area.items.length === 0) continue;
    const sorted = [...area.items].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    blocks.push(`#### ${area.name}\n${sorted.map((item) => itemMarkdown(item, done.has(item.id))).join('\n')}`);
  }
  const hidden = hiddenSummary(review.hidden);
  blocks.push(`<sub>Generated by PR Review Checklist.${hidden ? ` ${hidden}.` : ''}</sub>`);
  return `${blocks.join('\n\n')}\n`;
}

/** A file name for Download .md, like "review-bookshop-demo-1.md". */
export function markdownFileName(review) {
  if (!review.pr) return 'review-pasted-diff.md';
  const repo = String(review.pr.repo ?? '').split('/').at(-1).replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'pr';
  return `review-${repo}-${Number(review.pr.number) || 0}.md`;
}
