---
doc: checklist
status: approved
---

# Build Checklist

Build mode: fast (Priyansu can switch to learn mode at any time by saying so)

Approved 2026-10-07: Priyansu accepted the build order in the system design doc's roadmap with "do it". The slices below follow that roadmap, reshaped so each step is usable end to end.

## Slices

- [x] **1. Try the sample or paste a diff and see the counted facts**
  Becomes usable: Run `npm start`, open `http://localhost:3000`, click **Try a sample** (or paste a diff) and see the PR card and the counted facts for the five areas, such as "3 code files changed, 0 test files".
  Why now: Builds what every later step stands on (server, page, the diff reader that knows both line numbers, file labels) and the demo PR that every later test uses. The diff reader is where line numbers can go wrong, so it gets tested first.
  PRD ref: `prd.md > The Core Journey` (steps 1, 2, 4), `prd.md > Pasting a diff`, `prd.md > Trying the sample`
  Spec ref: `spec.md > Components` (Server, Diff reader, File labels, Facts and hints, Review runner), `spec.md > Data Model`, `spec.md > File Structure`, `spec.md > Stack`
  Build: `package.json` (ES modules, Express, Zod, start and test scripts), `lib/env.js`, `server.js` with `POST /api/review` streaming its steps and `GET /api/health`, `lib/diff.js`, `lib/classify.js`, `lib/facts.js`, a first `lib/review.js` (basic mode only), `samples/demo-pr.json` (the bookshop demo PR with its five planted issues) and `samples/clean-pr.json`, a plain first page (input, paste box, Try a sample, PR card, facts), `.env.example`, `LICENSE`, short `README.md`.
  Verify (mechanical): `npm test` passes tests for the diff reader (both line numbers, Windows line endings, the no-newline marker, renamed, deleted and binary files), file labels, facts, and `.env` reading (plain, byte-order mark, UTF-16). Start the server, send the sample and a pasted diff to `/api/review` with curl and check the streamed steps and facts. Playwright screenshot of the sample's results.
  Learner check: Start the app, click **Try a sample**, and check the facts match what the demo PR changes: code files changed and no test files.
  Commit: `Show counted facts for a pasted diff or the sample PR`

- [x] **2. Pattern hints point at the exact line, with the code shown**
  Becomes usable: Items such as "SQL built from user input" appear with a severity, a `file:line`, the code snippet with that line highlighted, why it matters, how to fix it, and a suggested comment. This all works with no AI key, so basic mode is real from here.
  Why now: Pointing at the right line and showing the right code is the machinery the AI items will reuse. Proving it on pattern hints first separates "can we point at lines" from "is the AI right".
  PRD ref: `prd.md > The checklist`, `prd.md > Basic mode`
  Spec ref: `spec.md > Components` (Facts and hints, Review runner), `spec.md > Data Model` (Item, Review)
  Build: `rules/*.json` for the five areas (JavaScript, TypeScript and Python patterns, plus each area's questions for the AI later), `lib/hints.js`, snippets (2 lines either side), sorting by severity, area statuses (issues, looks good, not checked in basic mode), the basic-mode pill and banner, item cards on the page.
  Verify (mechanical): `npm test`: hints find the planted SQL and database-call-in-a-loop lines in the sample at the right line numbers, and nothing on the clean sample; area statuses are right. Playwright screenshot of the sample in basic mode.
  Learner check: Try the sample and open the SQL item. Is the highlighted line the query built from the search text?
  Commit: `Add pattern hints with line snippets and basic mode`

- [x] **3. The AI reviewer adds items, and the line check hides any it can't match**
  Becomes usable: With an NVIDIA key, the review adds AI items (such as the changed user response and the stale README). AI items pointing at a made-up file or line are hidden as "couldn't be matched to the code". If the AI fails, the basic checklist appears with "The AI reviewer didn't answer" and **Retry**.
  Why now: This is the heart of the idea: the AI reviews, and plain code proves every line it points at. It comes before any polish.
  PRD ref: `prd.md > The checklist`, `prd.md > Proof and honesty`, `prd.md > Basic mode`
  Spec ref: `spec.md > Components` (Prompt builder, AI client, Line check, Review runner), `spec.md > External Services and Dependencies` (NVIDIA API catalog)
  Build: `lib/prompt.js` (numbered diff, file order, 60,000-character budget, PR text fenced as untrusted), `lib/ai.js` (the call, JSON-shape request with a plain retry, JSON extraction, Zod check, one retry, 60-second timeout, startup model check), `lib/verify.js` (all eight steps), merging AI items with hints ("Pattern and AI agree"), `samples/demo-ai-reply.json` with deliberate mistakes (made-up file, wrong line, misquoted code, a line two off), fallback to basic mode with Retry.
  Verify (mechanical): `npm test` with the AI call replaced by the saved reply: the made-up file and wrong line are hidden with reasons, the line two off is moved to the right line, the misquote is hidden, good items keep their snippets. A broken-JSON reply retries once and then falls back; a 400 on the JSON-shape option retries plainly. Prompt tests check line numbering and the size cut.
  Learner check: At the checkpoint on your PC (the AI service is blocked from Claude's cloud workspace), put your NVIDIA key in `.env`, try the sample, and check the pill says "AI reviewer on" and AI items appear.
  Commit: `Add AI review with line check`

- [x] **4. The claim check tries to disprove AI items, and you can see what was hidden**
  Becomes usable: Every item shows where it came from (Counted fact, Pattern and AI agree, AI confirmed, AI unconfirmed). Under the list, "N AI suggestions hidden" with **Show** lists each hidden item and why.
  Why now: It completes the trust story, the second half of the kernel, before more screens are built around it.
  PRD ref: `prd.md > Proof and honesty`, `prd.md > The checklist`
  Spec ref: `spec.md > Components` (Claim check, Review runner)
  Build: `lib/claims.js` (skeptic prompt, 5 lines of code either side, confirmed, rejected or unsure, fails safe), the `CLAIM_CHECK` setting, the caps (3 AI items per area, 12 total), where-it-came-from tags and the hidden list on the page, `samples/demo-claims-reply.json`.
  Verify (mechanical): `npm test` with saved replies: a rejected item is hidden with its reason, an unsure item drops one severity and is tagged AI unconfirmed, a failed claim check tags everything AI unconfirmed, the caps hold. Playwright screenshot of the open hidden list.
  Learner check: Try the sample, press **Show** under the list, and read why each item was hidden. Do the reasons make sense to you?
  Commit: `Add claim check, source tags and hidden list`

- [x] **5. Review a real public PR by its link**
  Becomes usable: Pasting a public GitHub PR link reviews that PR, and each `file:line` opens that exact line on GitHub. The same link within 10 minutes comes back instantly. Bad links, private PRs and a used-up GitHub limit each get the PRD's plain message, and "What was checked" lists skipped files.
  Why now: The sample has proven the whole pipeline, so the real input plugs into something that works. Right after this comes the first run on your PC, with real GitHub and real AI together.
  PRD ref: `prd.md > Reviewing a PR link`, `prd.md > States and Boundaries`, `prd.md > Proof and honesty` (What was checked)
  Spec ref: `spec.md > Components` (GitHub reader), `spec.md > External Services and Dependencies` (GitHub REST API), `spec.md > Important Failure Modes`
  Build: `lib/github.js` (link parsing, PR details, changed files with paging, README at the PR's commit, headers, optional `GITHUB_TOKEN`, 10-minute cache, plain error messages with the reset time), GitHub line links (PR commit for new lines, base commit for removed lines), the "What was checked" note, error messages under the input.
  Verify (mechanical): `npm test` with GitHub replaced by saved responses: link variants parse, a repeat link makes no new calls, 404, rate limit and network errors give the PRD's messages, a file with no patch is listed as skipped, links use the right commit and side, and request URLs are only ever built for api.github.com.
  Learner check: On your PC, paste the link of any small public PR and check that clicking a `file:line` opens the same line on GitHub.
  Commit: `Review public PRs by link`

- [x] **6. Copy Markdown, Copy comment and Download**
  Becomes usable: **Copy Markdown** puts a GitHub task list on the clipboard that shows tickable boxes and working line links when pasted into a PR comment. **Copy comment** copies one item's suggested comment. **Download .md** saves the same Markdown. A "Copied" note appears after each copy.
  Why now: This is how the checklist leaves the tool and reaches the PR. It needs the finished items, so it comes after them.
  PRD ref: `prd.md > Copying and sharing`, `prd.md > The Core Journey` (step 7)
  Spec ref: `spec.md > Components` (Markdown export, The page)
  Build: `public/markdown.js`, the sticky action bar, copy buttons with a fallback when the clipboard is blocked, the "Copied" note, Download.
  Verify (mechanical): `npm test` on `public/markdown.js`: task-list format, links for GitHub reviews, plain `file:line` for pasted diffs, code with backticks or pipes kept intact, hidden items left out. Playwright: click Copy Markdown and read the clipboard; the downloaded file matches it.
  Learner check: Copy Markdown on the sample, paste it into any GitHub comment box and click Preview (no need to post). The boxes and links should show.
  Commit: `Add Copy Markdown, Copy comment and Download`

- [x] **7. The finished look: loading steps, every state, dark and light, phone**
  Becomes usable: The page looks and behaves as the PRD describes: live loading steps with seconds and Cancel, the all-clear state, every error state, the basic-mode banner, dark and light themes, keyboard use, and a phone-width layout.
  Why now: The behavior is settled, so the design work won't be redone.
  PRD ref: `prd.md > Screens and Layout`, `prd.md > Look and Feel`, `prd.md > States and Boundaries`
  Spec ref: `spec.md > Look and Feel`, `spec.md > Components` (The page)
  Build: `public/styles.css` color and spacing variables from the design doc, the Loading view driven by the streamed steps, Cancel, Review disabled while running, the all-clear state, the error states, the three how-it-works steps, the privacy note, light theme from the system setting, reduced motion, phone layout, focus styles.
  Verify (mechanical): Playwright screenshots of every state in dark and light at desktop and 390px width; no sideways scrolling at 390px; Tab reaches the input and Enter starts a review; Cancel stops the request on the server; a diff containing `<script>` shows as plain text.
  Learner check: Open the app on your PC in dark and light mode and in a narrow window, try a link, the sample and a bad link, and say what feels off.
  Commit: `Finish page design and states`

- [x] **8. Demo repo, clean PR and the evaluation**
  Becomes usable: A small bookshop demo repo, ready for you to push to your GitHub account, with the five-issue PR and the clean PR. `node eval/run-eval.js --runs 10` prints planted issues found, false alarms on the clean PR, and items hidden by each check, and `--model` compares NVIDIA models.
  Why now: It needs the whole pipeline. Its numbers decide the model and tune the prompt before the final review.
  PRD ref: `prd.md > What We're Building`, `prd.md > The checklist` (planted issues), `prd.md > Open Questions`
  Spec ref: `spec.md > Components` (Samples and evaluation), `spec.md > Decisions and Open Issues`
  Build: `demo/bookshop-demo` with its main branch and the two PR branches, a check that the saved samples match the demo repo's real diffs, `eval/run-eval.js` with `--runs`, `--model` and `eval/real-prs.json`, README steps for pushing the demo repo and running the evaluation.
  Verify (mechanical): `npm test` passes; the sample check confirms `samples/*.json` equal the demo repo's diffs; the evaluation run against saved replies prints the score table with the expected counts.
  Learner check: Push the demo repo to your GitHub (README steps), review its PR link with the app, then run the evaluation with your key and read the score.
  Commit: `Add demo repo, clean PR and evaluation`

## Hands-on Checkpoints

- [ ] Early usable behavior explored — after slice 5, the first run on Priyansu's PC with his NVIDIA key and a real public PR (first live GitHub and AI run; what he notices shapes the prompt, the model and slices 6–8)
- [ ] Final kick-the-tires exploration and feedback completed

## Final Review

- [ ] Final review complete — feedback resolved and learner confirms ready to ship

## Code Tour and App Map

- [ ] Learning activity complete — guided route, focused alternative, prior practice connected, or brief recap
- [ ] Optional edit and transfer reflection addressed — offered/declined/already covered/not applicable as appropriate
- [ ] `devpost/app-map.html` generated from finished code, checked, and shown, including a project-grounded practice to reuse

Activity and evidence: [what actually happened; real document/test/code references; unfinished work if interrupted]
Route and stops: [actual paths and symbols; guided stops completed, or reference-only route]
Edit outcome: [tried/kept/reverted/declined/not applicable; verification if changed]
Reflection: [offered/answered/declined/already covered — personal answer belongs only in the ignored profile]
Activity mode: [live app and editor, explicit static fallback, focused alternative, prior practice, or recap]

## Revisions

- Added `lib/areas.js` for the area names, severity order and sorting — facts, hints and the line check all need them, and the spec's file list had no shared home for them.
- Built the bookshop demo repo files and `demo/build-demo.js` in slice 1 instead of slice 8 — the samples every test uses must be the demo repo's real diffs, and building the repo with fixed dates gives the same commit ids on any computer, so sample links will work once the repo is pushed. Slice 8 keeps pushing the repo and the evaluation.
- Added a fifth where-it-came-from tag, **Pattern match**, in `prd.md > The checklist` — basic mode shows pattern hints on their own, and none of the four planned tags described an item found only by a pattern.
