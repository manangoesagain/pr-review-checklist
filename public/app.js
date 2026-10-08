// The page: sends a review request, shows the real progress steps the server
// streams back, then draws the checklist. Everything from the server is put on
// the page with textContent, never as HTML, so code in a PR can't run here.

import { hiddenSummary, markdownFileName, reviewMarkdown, SEVERITY_LABELS } from './markdown.js';

const SEVERITY_ORDER = ['must-fix', 'worth-asking', 'good-to-know'];
const AREA_ORDER = ['security', 'tests', 'breaking', 'docs', 'performance'];
const CHIP_NAMES = { security: 'Security', tests: 'Tests', breaking: 'Breaking', docs: 'Docs', performance: 'Performance' };
const STEP_LABELS = { fetch: 'Fetching PR', facts: 'Checking facts', ai: 'Asking the reviewer', verify: 'Checking every line' };
const DIFF_EXAMPLE = '--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,2 @@';

const $ = (selector) => document.querySelector(selector);

const state = {
  health: { ai: false, model: null, problem: null },
  lastBody: null,
  review: null,
  controller: null,
  pasteMode: false,
  filter: null,
  timer: null,
  done: new Set(), // ids of the items the person ticked
};

// Builds an element. Text always goes in as text, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'hidden') node.hidden = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function compareItems(a, b) {
  return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area);
}

// Only links the app itself built, to github.com, are ever made clickable.
function safeGitHubLink(url) {
  return typeof url === 'string' && url.startsWith('https://github.com/') ? url : null;
}

/* ---------- Views ---------- */

// The page stays put; a review runs and shows in a pop-up over it.
function showView(name) {
  $('#loading-view').hidden = name !== 'loading';
  $('#results-view').hidden = name !== 'results';
  $('#reopen-review').hidden = !state.review || name !== 'start';
  if (name === 'start') return closeModal();
  $('#modal-title').textContent = name === 'loading' ? 'Reviewing the pull request' : 'Review output';
  updateTally();
  openModal();
}

// The pop-up's small label: what's running, or how many items are ticked off.
function updateTally() {
  const label = $('#review-state');
  if (!$('#loading-view').hidden) { label.textContent = 'REVIEW / RUNNING'; return; }
  const count = state.review?.areas.reduce((sum, area) => sum + area.items.length, 0) ?? 0;
  label.textContent = count === 0 ? 'REVIEW / ALL CLEAR' : `REVIEW / ${state.done.size} OF ${count} TICKED OFF`;
}

let lastFocus = null;

function openModal() {
  const modal = $('#review-modal');
  if (!modal.hidden) return;
  lastFocus = document.activeElement;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => { if (!modal.hidden) modal.classList.add('is-open'); });
  $('.modal-card').scrollTop = 0;
  $('#modal-close').focus();
}

function closeModal() {
  const modal = $('#review-modal');
  if (modal.hidden) return;
  modal.classList.remove('is-open');
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  lastFocus?.focus?.();
}

// Closing while a review runs cancels it.
function dismissModal() {
  if (state.controller) state.controller.abort();
  showView('start');
}

function setBusy(busy) {
  for (const button of document.querySelectorAll('#review-btn, #review-diff-btn, #try-sample')) button.disabled = busy;
}

function showError(error) {
  const box = $('#form-error');
  box.replaceChildren(el('p', { text: error.message }));
  if (error.code === 'not-a-diff') {
    box.append(el('pre', { text: DIFF_EXAMPLE }));
  }
  if ((error.code === 'pr-not-found' || error.code === 'rate-limit') && !state.pasteMode) {
    box.append(el('button', { type: 'button', class: 'link', text: 'Paste the diff instead', onclick: () => setPasteMode(true) }));
  }
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

function hideError() {
  $('#form-error').hidden = true;
  $('#form-error').replaceChildren();
}

function setPasteMode(on) {
  state.pasteMode = on;
  $('#link-row').hidden = on;
  $('#paste-box').hidden = !on;
  $('#toggle-paste').textContent = on ? 'Use a PR link instead' : 'Paste a diff instead';
  hideError();
  (on ? $('#diff-text') : $('#pr-url')).focus();
}

/* ---------- Loading ---------- */

function plannedSteps(body) {
  const steps = body.url ? ['fetch', 'facts'] : ['facts'];
  if (state.health.ai) steps.push('ai', 'verify');
  return steps;
}

function renderSteps(steps) {
  $('#steps').replaceChildren(...steps.map((step) => el('li', { 'data-step': step, text: STEP_LABELS[step] })));
}

function markStep(step) {
  const items = [...$('#steps').children];
  let index = items.findIndex((li) => li.dataset.step === step);
  if (index === -1) {
    $('#steps').append(el('li', { 'data-step': step, text: STEP_LABELS[step] ?? step }));
    index = items.length;
  }
  [...$('#steps').children].forEach((li, i) => {
    li.classList.toggle('is-done', i < index);
    li.classList.toggle('is-active', i === index);
  });
}

function startTimer() {
  const started = performance.now();
  $('#elapsed').textContent = '0';
  state.timer = setInterval(() => {
    $('#elapsed').textContent = String(Math.floor((performance.now() - started) / 1000));
  }, 250);
}

function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

/* ---------- Talking to the server ---------- */

// Reads the server's reply one JSON line at a time, as each step happens.
async function streamReview(body, signal, onStep) {
  const response = await fetch('/api/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.step) onStep(message.step);
      if (message.review || message.error) result = message;
    }
    if (done) break;
  }
  return result ?? { error: { code: 'server', message: 'The server stopped before the review finished. Please try again.' } };
}

async function startReview(body) {
  state.lastBody = body;
  hideError();
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  setBusy(true);
  renderSteps(plannedSteps(body));
  showView('loading');
  startTimer();
  try {
    const result = await streamReview(body, controller.signal, markStep);
    if (result.error) {
      showView('start');
      showError(result.error);
    } else {
      state.review = result.review;
      renderResults(result.review);
      showView('results');
      $('.modal-card').scrollTop = 0;
    }
  } catch (error) {
    showView('start');
    if (error.name !== 'AbortError') {
      showError({ code: 'network', message: 'Couldn\'t reach the app\'s server. Is it still running? Start it again with npm start.' });
    }
  } finally {
    stopTimer();
    setBusy(false);
    if (state.controller === controller) state.controller = null;
  }
}

/* ---------- Results ---------- */

function provenance(item) {
  if (item.origin === 'fact') return 'Counted fact';
  if (item.origin === 'hint') return 'Pattern match';
  if (item.origin === 'agree') return 'Pattern and AI agree';
  return item.confidence === 'confirmed' ? 'AI, confirmed' : 'AI, unconfirmed';
}

function refText(item) {
  return item.line ? `${item.file}:${item.line}` : item.detail ?? item.file ?? '';
}

function refNode(item) {
  const text = refText(item);
  const link = item.line ? safeGitHubLink(item.link) : null;
  const title = item.side === 'L' ? `Line ${item.line} of the file before this change` : text;
  return el('span', { class: 'item-ref', title },
    link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text }) : text);
}

function snippetNode(item) {
  if (!Array.isArray(item.snippet) || item.snippet.length === 0) return null;
  const signs = { add: '+', del: '-', ctx: ' ' };
  return el('pre', { class: 'snippet', 'aria-label': `Code at ${refText(item)}` },
    item.snippet.map((row) => el('div', { class: `snippet-row is-${row.type}${row.hit ? ' is-hit' : ''}` },
      el('span', { class: 'snippet-num', text: row.line ?? '' }),
      el('span', { class: 'snippet-sign', text: signs[row.type] ?? ' ' }),
      el('code', { class: 'snippet-code', text: row.text }))));
}

function itemNode(item, open) {
  const bodyId = `item-body-${item.id}`;
  const node = el('li', { class: `item sev-${item.severity}${open ? ' is-open' : ''}`, id: `item-${item.id}`, 'data-area': item.area });
  const check = el('input', { type: 'checkbox', class: 'item-check', 'aria-label': `Done: ${item.title}` });
  check.addEventListener('change', () => {
    node.classList.toggle('is-done', check.checked);
    if (check.checked) state.done.add(item.id);
    else state.done.delete(item.id);
    updateTally();
  });

  const body = el('div', { class: 'item-body', id: bodyId, hidden: !open },
    snippetNode(item),
    item.why ? el('p', { class: 'item-text' }, el('strong', { text: 'Why it matters: ' }), item.why) : null,
    item.fix ? el('p', { class: 'item-text' }, el('strong', { text: 'How to fix it: ' }), item.fix) : null,
    item.comment ? el('blockquote', { class: 'comment', 'aria-label': 'Suggested comment' }, item.comment) : null,
    el('div', { class: 'item-foot' },
      el('span', { class: 'tag', text: provenance(item) }),
      item.comment ? el('button', { type: 'button', class: 'btn btn-small', text: 'Copy comment', onclick: () => copyText(item.comment, 'Comment copied') }) : null),
  );

  const toggle = el('button', { type: 'button', class: 'item-toggle', 'aria-expanded': String(open), 'aria-controls': bodyId },
    el('span', { class: 'sev', text: SEVERITY_LABELS[item.severity] ?? item.severity }),
    el('span', { class: 'item-title', text: item.title }));
  toggle.addEventListener('click', () => {
    const opening = body.hidden;
    body.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    node.classList.toggle('is-open', opening);
  });

  node.append(el('div', { class: 'item-head' }, check, toggle, refNode(item)), body);
  return node;
}

function prCard(review) {
  const { pr, stats } = review;
  const title = pr
    ? el('h2', { class: 'pr-title' }, pr.title || 'Untitled pull request', ' ', el('span', { class: 'pr-number', text: `#${pr.number}` }))
    : el('h2', { class: 'pr-title', text: 'Pasted diff' });
  const prLink = pr ? safeGitHubLink(pr.url) : null;
  return el('section', { class: 'pr-card', 'aria-label': 'Pull request' },
    title,
    el('p', { class: 'pr-meta' },
      pr ? (prLink ? el('a', { href: prLink, target: '_blank', rel: 'noopener noreferrer', text: pr.repo }) : el('span', { text: pr.repo })) : null,
      el('span', { text: plural(stats.files, 'file') }),
      el('span', {}, el('span', { class: 'add', text: `+${stats.additions}` }), ' ', el('span', { class: 'del', text: `−${stats.deletions}` })),
      el('span', { text: stats.seconds < 1 ? 'reviewed in under a second' : `reviewed in ${stats.seconds} s` })));
}

function chipNode(area) {
  const top = area.items.map((i) => i.severity).sort((a, b) => SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b))[0];
  const badge = area.status === 'issues'
    ? el('span', { class: 'chip-count', text: area.items.length })
    : el('span', { class: 'chip-state', text: area.status === 'clear' ? 'looks good' : 'not checked' });
  const chip = el('button', {
    type: 'button',
    class: `chip${top ? ` sev-${top}` : ''}${area.status === 'clear' ? ' is-clear' : ''}`,
    'aria-pressed': 'false',
    title: area.note ?? '',
    'data-area': area.id,
  }, CHIP_NAMES[area.id] ?? area.name, badge);
  chip.addEventListener('click', () => setFilter(state.filter === area.id ? null : area.id));
  return chip;
}

function setFilter(areaId) {
  state.filter = areaId;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.area === areaId));
  for (const item of document.querySelectorAll('.items .item')) item.hidden = Boolean(areaId) && item.dataset.area !== areaId;
  const note = $('#filter-note');
  if (!note) return;
  const area = state.review.areas.find((a) => a.id === areaId);
  if (!area) {
    note.hidden = true;
    return;
  }
  const verdict = area.status === 'clear' ? 'looks good' : 'not checked in basic mode';
  const text = area.items.length > 0
    ? `Showing ${area.name.toLowerCase()} only. `
    : `${area.name}: ${verdict}${area.note ? ` (${area.note})` : ''}. `;
  note.replaceChildren(text, el('button', { type: 'button', class: 'link', text: 'Show all', onclick: () => setFilter(null) }));
  note.hidden = false;
}

function basicBanner(review) {
  if (review.aiError) {
    return el('div', { class: 'banner', role: 'note' },
      el('div', { class: 'banner-text' },
        el('p', {}, el('strong', { text: 'The AI reviewer didn\'t answer,' }), ' so this is the basic check.'),
        el('p', { class: 'banner-detail', text: review.aiError })),
      el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: 'Retry',
        onclick: () => { if (state.lastBody && !state.controller) startReview(state.lastBody); },
      }));
  }
  return el('div', { class: 'banner', role: 'note' },
    el('p', {}, el('strong', { text: 'Basic mode:' }), ' counted facts and patterns only. Add an AI key for the full review.'));
}

function allClearNode(review) {
  const files = plural(review.stats.reviewed, 'file');
  return review.mode === 'basic'
    ? el('div', { class: 'all-clear is-basic' },
      el('h2', { text: `Nothing flagged by the basic checks in ${files}` }),
      el('p', { text: 'The AI reviewer is off, so areas marked "not checked" still need a look.' }))
    : el('div', { class: 'all-clear' },
      el('h2', { text: `No problems found in ${files}` }),
      el('p', { text: 'Every area was checked. See what was checked below.' }));
}

function hiddenRef(entry) {
  if (!entry.file) return '';
  const match = /^([RL])(\d+)$/.exec(String(entry.ref ?? ''));
  if (!match) return entry.file;
  return `${entry.file}:${match[2]}${match[1] === 'L' ? ' (removed line)' : ''}`;
}

// "3 AI suggestions hidden: 2 couldn't be checked against the code, 1 rejected by the second check. Show"
function hiddenNode(review) {
  const hidden = review.hidden ?? [];
  if (hidden.length === 0) return null;
  const list = el('ul', { class: 'hidden-list', id: 'hidden-list', hidden: true },
    hidden.map((entry) => el('li', {},
      el('span', { class: 'hidden-title', text: entry.title }),
      hiddenRef(entry) ? el('code', { class: 'hidden-ref', text: hiddenRef(entry) }) : null,
      el('span', { class: 'hidden-reason', text: `Hidden because ${entry.reason.replace(/[.!?]+$/, '')}.` }))));
  const toggle = el('button', { type: 'button', class: 'link', 'aria-expanded': 'false', 'aria-controls': 'hidden-list', text: 'Show' });
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.textContent = list.hidden ? 'Show' : 'Hide';
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  });
  return el('div', { class: 'hidden-row' },
    el('p', {}, `${hiddenSummary(hidden)}. `, toggle),
    list);
}

function checkedNode(review) {
  const files = review.checked.files;
  const shown = files.slice(0, 50);
  const describe = (f) => {
    const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    return el('li', {}, el('code', { text: name }), ` ${f.kind}, +${f.additions} −${f.deletions}`);
  };
  return el('details', { class: 'checked' },
    el('summary', { text: `What was checked: ${plural(files.length, 'file')} reviewed${review.checked.skipped.length ? `, ${review.checked.skipped.length} skipped` : ''}` }),
    el('h3', { text: 'Reviewed' }),
    el('ul', {}, shown.map(describe), files.length > shown.length ? el('li', { text: `and ${files.length - shown.length} more` }) : null),
    review.checked.skipped.length ? [
      el('h3', { text: 'Skipped' }),
      el('ul', {}, review.checked.skipped.map((s) => el('li', {}, el('code', { text: s.path }), ` ${s.reason}`))),
    ] : null,
    el('h3', { text: 'Limits' }),
    el('ul', {},
      el('li', { text: 'Only the changed lines and the few lines around them are reviewed, so code that calls a changed function isn\'t visible.' }),
      review.mode === 'basic' ? el('li', { text: 'Basic mode counts facts and matches known patterns. It can\'t judge whether code is correct.' }) : null,
      review.notes.map((note) => el('li', { text: note }))));
}

/* ---------- Copy and download ---------- */

let toastTimer = null;
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

// Older browsers, or a blocked clipboard: copy through a hidden text box instead.
function copyWithTextBox(text) {
  const box = el('textarea', { class: 'copy-box', readonly: true, 'aria-hidden': 'true' });
  box.value = text;
  document.body.append(box);
  box.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  box.remove();
  return copied;
}

// If nothing can reach the clipboard, show the text selected so Ctrl+C works.
function showCopyDialog(text) {
  const box = el('textarea', { class: 'copy-dialog-text', readonly: true, rows: 12, 'aria-label': 'Text to copy' });
  box.value = text;
  const dialog = el('dialog', { class: 'copy-dialog', 'aria-label': 'Copy this text' },
    el('p', { text: 'Your browser blocked copying. Press Ctrl+C (or Cmd+C on a Mac) to copy the selected text.' }),
    box,
    el('form', { method: 'dialog' }, el('button', { type: 'submit', class: 'btn btn-small', text: 'Close' })));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  box.select();
  box.scrollTop = 0;
}

async function copyText(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
    return;
  } catch {
    // Fall through to the older way.
  }
  if (copyWithTextBox(text)) showToast(message);
  else showCopyDialog(text);
}

function copyMarkdown() {
  if (state.review) copyText(reviewMarkdown(state.review, { done: state.done }), 'Checklist copied as Markdown');
}

function downloadMarkdown() {
  if (!state.review) return;
  const blob = new Blob([reviewMarkdown(state.review, { done: state.done })], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: markdownFileName(state.review), hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Saved to your downloads');
}

function actionBar() {
  return el('div', { class: 'action-bar' },
    el('div', { class: 'wrap action-bar-inner' },
      el('button', { type: 'button', class: 'btn btn-small btn-primary', id: 'copy-md-btn', text: 'Copy Markdown', onclick: copyMarkdown }),
      el('button', { type: 'button', class: 'btn btn-small', id: 'download-btn', text: 'Download .md', onclick: downloadMarkdown }),
      el('button', { type: 'button', class: 'btn btn-small', text: 'Start over', onclick: startOver })));
}

function renderResults(review) {
  state.filter = null;
  state.done = new Set();
  const items = review.areas.flatMap((area) => area.items).sort(compareItems);
  $('#results-view').replaceChildren(...[
    review.mode === 'basic' ? basicBanner(review) : null,
    prCard(review),
    el('div', { class: 'chips', role: 'group', 'aria-label': 'Areas' }, review.areas.map(chipNode)),
    el('p', { class: 'filter-note', id: 'filter-note', hidden: true }),
    items.length > 0 ? el('ol', { class: 'items', 'aria-label': 'Checklist' }, items.map((item, i) => itemNode(item, i === 0))) : allClearNode(review),
    hiddenNode(review),
    checkedNode(review),
    actionBar(),
  ].filter(Boolean));
}

function startOver() {
  state.controller?.abort();
  state.review = null;
  $('#pr-url').value = '';
  $('#diff-text').value = '';
  $('#results-view').replaceChildren();
  hideError();
  showView('start');
  focusInput();
}

// Scrolls to the top and puts the cursor in the link box (or the diff box).
function focusInput() {
  window.scrollTo({ top: 0 });
  (state.pasteMode ? $('#diff-text') : $('#pr-url')).focus({ preventScroll: true });
}

/* ---------- Wiring ---------- */

function submit(event) {
  event?.preventDefault();
  if (state.controller) return; // A review is already running.
  if (state.pasteMode) {
    const diff = $('#diff-text').value;
    if (!diff.trim()) return showError({ message: 'Paste a diff first, or try the sample.' });
    return startReview({ diff });
  }
  const url = $('#pr-url').value.trim();
  if (!url) return showError({ message: 'Paste a pull request link first, or try the sample.' });
  return startReview({ url });
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    state.health = await response.json();
  } catch {
    state.health = { ai: false, model: null };
  }
  const pill = $('#mode-pill');
  const problem = state.health.ai && state.health.problem;
  pill.textContent = problem ? 'AI reviewer problem' : state.health.ai ? 'AI reviewer on' : 'Basic mode';
  pill.className = `pill ${state.health.ai && !problem ? 'is-ai' : 'is-basic'}`;
  pill.title = problem || (state.health.ai ? `Model: ${state.health.model}` : 'No AI key set: facts and pattern checks only');
  pill.hidden = false;
  if (!state.health.ai) {
    $('#privacy-note').textContent = 'Nothing is saved. The AI reviewer is off, so your code isn\'t sent to any AI service.';
  }
}

$('#review-form').addEventListener('submit', submit);
$('#toggle-paste').addEventListener('click', () => setPasteMode(!state.pasteMode));
$('#try-sample').addEventListener('click', () => {
  if (!state.controller) startReview({ sample: true });
});
$('#cancel-btn').addEventListener('click', () => state.controller?.abort());
$('#modal-close').addEventListener('click', dismissModal);
$('.modal-backdrop').addEventListener('click', dismissModal);
// "Start a review" at the bottom scrolls up and puts the cursor in the box.
$('#start-cta').addEventListener('click', (event) => {
  event.preventDefault();
  focusInput();
});
$('#reopen-review').addEventListener('click', () => { if (state.review) showView('results'); });
document.addEventListener('keydown', (event) => {
  const modalOpen = !$('#review-modal').hidden;
  if (event.key === 'Escape' && modalOpen) return dismissModal();
  // Ctrl+Enter (Cmd+Enter on a Mac) runs a review from anywhere on the page.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !modalOpen) submit(event);
  // Keep Tab inside the pop-up while it's open.
  if (event.key === 'Tab' && modalOpen) {
    const card = $('.modal-card');
    const focusable = [...card.querySelectorAll('button, a[href], input, summary, [tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null && !node.disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

showView('start');
loadHealth().then(() => {
  // The landing page's "Try the sample" button opens /app?sample=1.
  if (new URLSearchParams(location.search).has('sample')) {
    history.replaceState(null, '', location.pathname);
    startReview({ sample: true });
  }
});
