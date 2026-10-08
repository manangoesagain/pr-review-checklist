---
doc: spec
status: approved
---

# PR Review Checklist — Technical Spec

Approved 2026-10-07 together with the system design doc it is drawn from (Priyansu: "do it"). Every component below implements a heading in `prd.md`.

## How This Works, In Plain Language

There are two pieces. A **web page** in the browser, where you paste a link and read the checklist. And a small **server** on your laptop, which does all the work and keeps your keys secret.

When you press Review, the page sends the link to the server. The server asks GitHub for the PR's changes (the **diff**: the lines added and removed). It reads the diff into a tidy list where every line knows both its old and new line number. Plain code then counts the certain things (how many code files and test files changed) and looks for known risky patterns (like SQL built from user input). Then the server shows the AI the diff with every line already numbered, and asks it for a checklist in a fixed JSON format.

The AI can be wrong, so two checks run before you see anything. The **line check** (plain code) makes sure each item points at a line that really exists and quotes it correctly. The **claim check** (a second, short AI request) tries to disprove each item against its code. Anything that fails is hidden, with the reason. The server sends the checklist back, and the page draws it.

Why this shape: one small server and one plain page is the least you can build alone and still keep the AI key off the browser. No database, no accounts, no build step.

## The Core Journey Through the System
PRD ref: `prd.md > The Core Journey`.

1. You paste a link and press Review → `public/app.js` sends `POST /api/review` with `{ "url": "..." }` and starts reading the reply line by line.
2. `server.js` hands it to `lib/review.js`, which sends back `{"step":"fetch"}` → the page shows "Fetching PR".
3. `lib/github.js` checks the link, then makes three GitHub calls (PR details, changed files, README), or uses the 10-minute cache.
4. `lib/diff.js` turns each file's patch into hunks and lines with old and new numbers; `lib/classify.js` labels each file (code, test, docs, config, dependency, generated, binary) and skips lockfiles, images and generated files → `{"step":"facts"}`.
5. `lib/facts.js` and `lib/hints.js` (driven by `rules/*.json`) produce counted facts and pattern hints.
6. If an AI key is set: `lib/prompt.js` builds the numbered diff and messages; `lib/ai.js` calls the AI and checks its JSON → `{"step":"ai"}`.
7. `lib/verify.js` runs the line check; `lib/claims.js` runs the claim check → `{"step":"verify"}`.
8. `lib/review.js` merges facts, hints and verified AI items, attaches snippets and GitHub links, and sends the last line `{"review": {...}}`.
9. `public/app.js` draws the PR card, chips, items and hidden list. Copy buttons use `lib/markdown.js` logic (shared copy in `public/markdown.js`).

## Stack

- **Node.js 22 or newer** — runs the server and tests; already installed on Priyansu's PC for Trial Trap. [Docs](https://nodejs.org/docs/latest-v22.x/api/)
- **Express 5** — the small web server. [Docs](https://expressjs.com/en/5x/api.html)
- **Zod 4** — checks that the AI's JSON has the right shape before it is used. [Docs](https://zod.dev)
- **Node's built-in test runner** (`node --test`) — no extra test library. [Docs](https://nodejs.org/api/test.html)
- **Plain HTML, CSS and JavaScript** in `public/` — no React and no build step (accepted with the design doc: less to debug alone).
- **Playwright** (already in the cloud workspace) — screenshots of every screen state during the build only; not a project dependency.
- ES modules (`"type": "module"`), like Trial Trap.

Lessons carried over from Trial Trap's working setup (as ideas, not copied code): read `.env` whether Windows saved it as plain text, with a byte-order mark, or as UTF-16; clean pasted keys of quotes and invisible characters; ask NVIDIA for a JSON-shaped answer with `nvext.guided_json` and retry plainly if a model rejects that option; check the model and key once at startup and explain problems in plain words.

## Where It Runs and How Someone Tries It

- Runs locally: a Node server on `http://localhost:3000` (port changeable with `PORT` in `.env`), opened in any browser.
- Needs Node 22+. Optional: `NVIDIA_API_KEY` (AI review; without it, basic mode), `AI_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`; if it doesn't answer at startup, the app switches to the first working model in `MODEL_CHOICES` in `lib/ai.js`), `GITHUB_TOKEN` (raises GitHub's limit from 60 to 5,000 requests an hour).
- Start: `npm install`, copy `.env.example` to `.env` and paste the key, then `npm start`, then open `http://localhost:3000`.
- Demo recording: start the server, open the page, paste the demo PR link from the bookshop-demo repo, show the open item and the hidden list, copy Markdown into a GitHub comment, then review the clean PR to show "No problems found".
- Submission needs a demo video under 3 minutes and a public GitHub repo with these devpost docs and a LICENSE. No deployment planned (optional per the rules).
- Note: the AI service and GitHub API are blocked from Claude's cloud workspace, so live AI and live GitHub runs happen on Priyansu's PC; everything else is tested in the cloud with saved responses.

## Look and Feel
From `prd.md > Look and Feel`.

- Dark theme first (near-black blue-gray background, slightly lighter cards, soft borders), matching light theme via `prefers-color-scheme`. Colors defined once as CSS variables.
- One accent (a clear blue) for buttons, links and focus rings. Severity colors: red Must fix, amber Worth asking, gray Good to know, each always paired with its word.
- Fonts: Inter-like sans for text, JetBrains Mono-like monospace for code, using system font stacks so nothing loads from the internet.
- Calm and spacious, 8-pixel spacing steps, rounded corners (8px), thin borders, no gradients or glow.
- Code snippets: monospace, line numbers in a muted column, the flagged line on a soft red or amber band.
- Copy tone: direct and kind; every error says what to do next.
- Motion only for the loading steps and opening items; none under `prefers-reduced-motion`.

## Components

### Server (`server.js`)
Starts Express, serves `public/`, reads `.env`, checks the AI model at startup, exposes `POST /api/review` (streams JSON lines) and `GET /api/health` (`{ "ai": true|false, "model": "..." }`). Listens on 127.0.0.1 only.
PRD ref: `prd.md > Reviewing a PR link`, `prd.md > Basic mode`.

### GitHub reader (`lib/github.js`)
Parses a PR link (accepting `/files`, `#…`, `?…`, trailing slash), calls GitHub, returns PR details, file patches and README text. Caches by link for 10 minutes. Turns 404, 403/429 rate limits and network errors into plain messages. Never fetches a URL the user typed; it builds GitHub API URLs from the parsed owner, repo and number.
PRD ref: `prd.md > Reviewing a PR link`, `prd.md > States and Boundaries`.

### Diff reader (`lib/diff.js`)
Turns a unified diff (pasted, or GitHub's per-file `patch`) into the Diff model: files, hunks, lines with type (add, del, ctx) and old/new numbers. Handles Windows line endings, `\ No newline at end of file`, renames, deleted files and binary markers.
PRD ref: `prd.md > Pasting a diff`.

### File labels (`lib/classify.js`)
Labels each file code, test, docs, config, dependency, generated or binary from its path; marks lockfiles, images and generated files as skipped with a reason.
PRD ref: `prd.md > Proof and honesty` (What was checked).

### Facts and hints (`lib/facts.js`, `lib/hints.js`, `rules/*.json`)
Facts: certain counts from the Diff (code vs. test files, docs touched, dependency manifests changed, deleted or renamed files, migrations). Hints: regex patterns per area from the rule files, matched only on added lines, each with a title, severity, why and fix. Each rule file also holds the AI's checklist questions for that area.
PRD ref: `prd.md > The checklist`, `prd.md > Basic mode`.

### Prompt builder (`lib/prompt.js`)
Builds the numbered diff (`R15 |+ code`, `L41 |- code`), orders files code → config → tests → docs, cuts at about 60,000 characters and records what was cut, and assembles the system prompt (rules, per-area questions, field order) and user message (`<pr_text>`, facts and hints, `<readme>`, `<diff>`).
PRD ref: `prd.md > The checklist`.

### AI client (`lib/ai.js`)
Calls NVIDIA's OpenAI-style chat endpoint with temperature 0.2 and a 60-second timeout, asks for the reply schema with `nvext.guided_json`, retries without it on 400/422, pulls the JSON out of the reply (ignoring fences and `<think>` blocks), validates it with Zod, retries once on bad JSON, and otherwise reports failure so the review falls back to basic mode. Also the startup model check.
PRD ref: `prd.md > The checklist`, `prd.md > Basic mode`.

### Line check (`lib/verify.js`)
The eight steps in the design doc: file exists (unique trailing-path match allowed), line exists on that side, evidence matches after removing copied prefixes and collapsing spaces, snap within 3 lines in the same hunk, otherwise unique match in the file, fix area and severity values, merge duplicates (AI replaces a matching hint, tag becomes "Pattern and AI agree"), attach snippet (2 lines either side) and GitHub link (head commit for R lines, base commit for L lines).
PRD ref: `prd.md > Proof and honesty`.

### Claim check (`lib/claims.js`)
One AI request with all surviving AI items, each with its claim and a snippet of 5 lines either side. The skeptic prompt returns confirmed, rejected or unsure with a reason per item. Rejected → hidden with reason; unsure → one severity lower and tagged "AI, unconfirmed"; failure → all tagged "AI, unconfirmed". Controlled by `CLAIM_CHECK` (on by default).
PRD ref: `prd.md > Proof and honesty`.

### Review runner (`lib/review.js`)
Runs the steps in order, reports progress, chooses AI or basic mode, merges and sorts items (severity, then area order), caps at 3 AI items per area and 12 total, sets area statuses (issues, clear, unchecked, or partial when the AI read only part of the PR), and builds the Review object with stats and notes.
PRD ref: `prd.md > The Core Journey`.

### Markdown export (`public/markdown.js`)
Turns a Review into GitHub task-list Markdown (format in the design doc), with links for GitHub reviews and plain `file:line` for pasted diffs. Lives in `public/` so the browser can use it; tests import the same file.
PRD ref: `prd.md > Copying and sharing`.

### The page (`public/index.html`, `public/app.js`, `public/styles.css`)
Start, Loading and Results views; reads the streamed steps; draws everything with `textContent` (never HTML from data); copy buttons with a "Copied" toast; Show hidden; basic-mode banner; error messages under the input; dark and light themes; keyboard and phone layouts.
PRD ref: `prd.md > Screens and Layout`, `prd.md > States and Boundaries`, `prd.md > Look and Feel`.

### Samples and evaluation (`samples/`, `eval/run-eval.js`)
Saved GitHub responses for the demo PR and the clean PR, and saved AI replies (including deliberate mistakes) for tests. The eval script runs the real AI N times on the demo and clean PRs (and on real PRs listed in `eval/real-prs.json`), and prints planted issues found, false alarms, and items hidden by each check. `--model` compares models.
PRD ref: `prd.md > Trying the sample`, `prd.md > Proof and honesty`.

## Data Model

Everything lives in memory for one review; nothing is stored on disk.

- **Diff**: `{ source, repo, number, title, body, headSha, baseSha, readme, files: [{ path, oldPath, status, kind, additions, deletions, hunks: [{ oldStart, newStart, lines: [{ type, old, new, text }] }] }], skipped: [{ path, reason }] }`.
- **Item**: `{ id, area, title, severity, origin, confidence, file, side, line, evidence, why, fix, comment, snippet, link }`.
- **Review**: `{ mode, pr, stats, areas: [{ id, name, status, items }], hidden: [{ title, file, line, reason, removedBy }], notes }`.
- **Cache**: a Map from normalized PR link to `{ diff, savedAt }`, entries older than 10 minutes ignored; cleared when the server stops.
- Field-by-field examples are in the system design doc (Data model section).

## File Structure

```
pr-checklist/
├── server.js                 # Express app, .env reading, startup model check, API routes
├── lib/
│   ├── env.js                # read .env (plain, BOM, UTF-16), clean keys
│   ├── areas.js              # the five areas, severity order, sorting (shared)
│   ├── github.js             # parse PR link, GitHub calls, cache, friendly errors
│   ├── diff.js               # unified diff → Diff model (both line numbers)
│   ├── classify.js           # file kinds and skip reasons
│   ├── facts.js              # counted facts per area
│   ├── hints.js              # pattern hints from rules/*.json
│   ├── prompt.js             # numbered diff, size budget, messages
│   ├── ai.js                 # NVIDIA call, JSON extraction, Zod check, retry, model check
│   ├── verify.js             # line check
│   ├── claims.js             # claim check
│   └── review.js             # runs the pipeline, merges, sorts, caps, streams steps
├── rules/
│   ├── tests.json  breaking.json  docs.json  performance.json  security.json
├── public/
│   ├── index.html            # the one page
│   ├── app.js                # views, streaming, rendering, copy
│   ├── markdown.js           # Review → Markdown (shared with tests)
│   └── styles.css            # dark and light themes, layout
├── samples/
│   ├── demo-pr.json          # saved GitHub responses for the demo PR
│   ├── clean-pr.json         # saved GitHub responses for the clean control PR
│   ├── demo-ai-reply.json    # saved AI reply with deliberate mistakes
│   └── demo-claims-reply.json# saved claim-check reply
├── demo/
│   ├── bookshop-demo/        # the demo repo's files: main, order-search (5 issues), isbn-lookup (clean)
│   └── build-demo.js         # builds the demo git repo with fixed commit ids, and rebuilds samples/
├── eval/
│   ├── run-eval.js           # real-AI evaluation (run on your PC)
│   └── real-prs.json         # small real public PRs you grade yourself
├── test/                     # node --test files, one per lib file + pipeline + server
├── devpost/                  # scope, prd, spec, checklist (learner-profile is git-ignored)
├── .env.example              # NVIDIA_API_KEY=, AI_MODEL=, GITHUB_TOKEN=, CLAIM_CHECK=on, PORT=3000
├── .gitignore
├── LICENSE                   # MIT
├── package.json
└── README.md
```

## External Services and Dependencies

### GitHub REST API
- `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` → title, body, `head.sha`, `base.sha`. [Docs](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
- `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files?per_page=100&page=N` → `[{ filename, previous_filename, status, additions, deletions, patch }]`; at most 3,000 files; `patch` missing for very large or binary files. [Docs](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
- `GET https://api.github.com/repos/{owner}/{repo}/readme?ref={headSha}` with `Accept: application/vnd.github.raw+json` → README text; 404 means no README. [Docs](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme)
- Headers: `User-Agent`, `X-GitHub-Api-Version: 2022-11-28`, and `Authorization: Bearer {GITHUB_TOKEN}` when set.
- Limits: 60 requests an hour without a token, 5,000 with one ([Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)); read `x-ratelimit-remaining` and `x-ratelimit-reset`. Free.

### NVIDIA API catalog (AI)
- `POST https://integrate.api.nvidia.com/v1/chat/completions` with `{ model, messages, temperature: 0.2, max_tokens, nvext: { guided_json } }`, header `Authorization: Bearer {NVIDIA_API_KEY}`; reply text in `choices[0].message.content`. `GET /v1/models` lists models for the startup check. [Catalog](https://build.nvidia.com) · [API reference](https://docs.api.nvidia.com/nim/reference/llm-apis)
- Two calls per review (review and claim check). Uses Priyansu's existing NVIDIA credits; about 15,000 input tokens for the review of a medium PR (estimate).

## Important Failure Modes

- **The AI invents or misplaces findings** → the line check and claim check hide them, with reasons in the hidden list.
- **The AI is slow, down, out of credits, or returns broken JSON twice** → basic checklist with "The AI reviewer didn't answer" and Retry.
- **GitHub limit used up during rehearsals** → cache for 10 minutes, the offline sample, paste-a-diff, and the optional token; the message says when the limit resets.
- **A big PR overflows the AI's budget** → the first part is reviewed and every skipped file is named.

## What Was Simplified and Why

- **Plain HTML and JavaScript** instead of React with shadcn/ui — one page doesn't need a build step; React would add setup to debug alone.
- **Review the diff only** instead of whole files — keeps it to three GitHub calls; whole files would need many more calls or a token.
- **One review call plus one claim check** instead of one call per area — less waiting; per-area calls stay an evaluation experiment.
- **Memory cache** instead of a database — nothing needs to survive a restart.
- **Copy Markdown** instead of posting to GitHub — no sign-in or write token needed.

## Decisions and Open Issues

Learner choices (Priyansu): audience of beginners and solo developers; project separate from his other entries; name later; and, accepted from recommendations with "do it" on 2026-10-07, dark-first theme, basic mode, suggested comments, JavaScript/TypeScript/Python pattern hints, the claim check, and the demo repo under his GitHub account.

Implementation details derived from those choices (agent): Zod instead of dotenv as the second dependency (Node can read `.env` itself; Zod checks AI replies); streaming JSON lines for real progress; caps of 3 items per area and 12 total; 60,000-character diff budget.

Learner uncertainty: whether the AI can be trusted to point at the right code. The design answers it with the line check and claim check, and the build will measure it with the evaluation (planted issues found, false alarms on the clean PR) on Priyansu's PC.

Open: the best NVIDIA model for code review (decided by the evaluation); the final name (at ship time); GitHub and NVIDIA behavior can only be confirmed on Priyansu's PC, so the first PC run is an early checkpoint.
