---
doc: prd
status: approved
---

# PR Review Checklist — Product Requirements

Paste a GitHub pull request link and get the checklist a careful senior reviewer would run, with every item proving itself against the real code. For beginners reviewing someone else's PR and solo developers checking their own. ("PR Review Checklist" is a working name; the final name is still open.)
Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`.

## The Core Journey
Source: `scope.md > The Core Loop`, `scope.md > What "Working" Looks Like`.

1. The person opens the page. They see one line saying what it does, one input box, a **Review** button, and two links: **Paste a diff instead** and **Try a sample**.
2. They paste a public GitHub PR link (for example `github.com/manangoesagain/bookshop-demo/pull/7`) and press Review or Enter.
3. A loading view shows the real step being worked on: Fetching PR, Checking facts, Asking the reviewer, Checking every line, with seconds elapsed and a Cancel link.
4. The results appear: a PR card (title, repo, number of files, lines added and removed, time taken), five area chips (Security, Tests, Breaking changes, Docs, Performance) with counts, and the checklist items ordered by severity.
5. The most important item is open. It shows the severity, a title, a `file:line` link to GitHub, the code snippet with the flagged line highlighted, why it matters, how to fix it, where the item came from, and a **Copy comment** button.
6. Under the list, a line says how many AI suggestions were hidden and why (for example "2 AI suggestions hidden: 1 unmatched line, 1 rejected claim"), with **Show** to see them.
7. They tick items as they review, click **Copy Markdown**, and paste the checklist into the PR or their notes. Or they copy one item's comment and post it on the PR.
8. They press **Start over** (or paste a new link) for the next PR.

Success: a real reviewer finds at least one useful thing they would have missed, and every item on screen points at code that is really there.

## Screens and Layout

One page with three views that replace each other in place: **Start** (input), **Loading**, **Results**. The input stays at the top in every view so a new link can be pasted at any time. A sticky action bar (Copy Markdown, Download .md, Start over) sits at the bottom of the Results view. A small pill at the top right says "AI reviewer on" or "Basic mode".

The results layout is drawn in the system design doc (Screen design section): PR card, chip row, items, hidden line, sticky bar.

## Look and Feel
Source: `scope.md > Inspiration & Identity` ("a senior engineer who's on your side: calm, direct, specific"; "pro look").

- Dark theme first, with a matching light theme that follows the system setting (Priyansu accepted this, 2026-10-07).
- A polished developer tool, not a toy: calm, neutral surfaces, one accent color for actions and links, so red and amber items are what the eye finds first.
- Clean sans-serif text (Inter character) and a monospace font for code (JetBrains Mono character), with system fonts as fallback so it works offline.
- Severity always shows a word and a color, never color alone: red for **Must fix**, amber for **Worth asking**, gray for **Good to know**.
- Copy is direct and kind, like a senior colleague: no jargon without a one-line explanation, never blaming the author.
- Avoid generic AI-app styling: no gradients, glow, emoji headers or decorative sparkles.

## Features and Behavior

### Reviewing a PR link
Source: `scope.md > The POC Boundary`.

- As a beginner reviewing a classmate's PR, I want to paste its link and get a checklist so that I know what to look for.
  - [ ] Pasting a valid public PR link and pressing Review shows results for that PR's changed files.
  - [ ] Links with extra parts (`/files`, `#discussion…`, `?w=1`, trailing slash) still work.
  - [ ] Reviewing the same link again within 10 minutes shows results immediately.

### Pasting a diff
- As a solo developer with a private repo, I want to paste the output of `git diff` so that I can still get a review.
  - [ ] Pasting a unified diff (including one saved on Windows) produces the same kind of checklist, without GitHub links.
  - [ ] Text that isn't a diff gets a plain message with a 3-line example of what a diff looks like.

### Trying the sample
- As a judge or first-time visitor, I want one click to see what the tool does so that I don't need a PR of my own.
  - [ ] **Try a sample** reviews a saved demo PR and works with no internet and no GitHub quota.

### The checklist
Source: `scope.md > The Unique Kernel`.

- Five areas: Tests, Breaking changes, Docs, Performance, Security.
- Each item has: severity, a short title, a `file:line` reference (or a count for facts like "3 code files, 0 tests"), the code snippet with the flagged line highlighted, **Why it matters** (one plain sentence), **How to fix it** (one suggestion), a **where it came from** tag, and a **suggested comment**.
- Where-it-came-from tags: **Counted fact**, **Pattern match**, **Pattern and AI agree**, **AI, confirmed**, **AI, unconfirmed**.
- Breaking-change items are phrased as questions for the author, because the tool can't see the code that calls a changed function.
- An area with nothing found says so ("Docs: looks good") instead of staying blank.
- At most 3 AI items per area and 12 in total, most important first.
  - [ ] On the demo PR, all five planted issues appear, each pointing at the right file and line.
  - [ ] Every item with a line reference shows the exact code from that line.
  - [ ] Clicking a `file:line` link opens that line on GitHub at the PR's commit.

### Proof and honesty
Source: `scope.md > The Unique Kernel`, `scope.md > The POC Boundary`.

- An AI item is shown only if its file, line and quoted code are found in the real diff (the line check), and a second AI pass didn't reject it (the claim check).
- Hidden items are listed with the reason when the person presses **Show**.
- A "What was checked" note lists files reviewed, files skipped and why (lockfiles, images, too big), and the known limits.
  - [ ] A made-up line reference never appears as an item; it shows in the hidden list as "couldn't be matched to the code".
  - [ ] A clean PR with no problems comes back "No problems found" with every area marked as checked.

### Copying and sharing
- As any reviewer, I want to copy the checklist so that I can paste it into the PR.
  - [ ] **Copy Markdown** copies a GitHub task list; pasted into a GitHub comment it shows tickable boxes and working line links.
  - [ ] **Copy comment** on an item copies that item's suggested comment.
  - [ ] **Download .md** saves the same Markdown as a file.
  - [ ] A short "Copied" confirmation appears after each copy.

### Basic mode
- As someone running the project without an AI key, I want a useful checklist anyway so that the tool still works.
  - [ ] With no AI key, the pill says "Basic mode", a banner explains what that means, and counted facts and pattern hints still appear.
  - [ ] Areas only the AI can judge say "Not checked in basic mode".
  - [ ] If the AI fails or times out during a review, the basic checklist appears with "The AI reviewer didn't answer" and a **Retry** button.

## States and Boundaries

- **First use / Start** — promise line, input, Review button, Paste a diff instead, Try a sample, three tiny "how it works" steps.
- **Loading** — the live step, seconds elapsed, Cancel. The Review button is disabled while a review runs.
- **Results** — as in The Core Journey.
- **All clear** — "No problems found in N files", every chip marked fine, plus what was checked.
- **Basic mode** — amber banner, pill says "Basic mode", AI-only areas marked "Not checked in basic mode".
- **Errors** — a plain sentence under the input with the next step; the typed link stays in the box:
  - Not a PR link → "That doesn't look like a pull request link. It should end in /pull/ and a number."
  - Private or missing PR → "Couldn't open that PR. If the repo is private, paste the diff instead." with a button to switch.
  - GitHub limit used up → "GitHub's free limit is used up until [time]. Add a GITHUB_TOKEN to your .env file, or paste the diff."
  - Nothing to review → "Nothing to review: this PR only changes package-lock.json."
  - PR too big → reviews the first part and lists the files not reviewed.
- **What persists** — nothing between visits. Reviews are cached in the server's memory for 10 minutes and gone when it stops. Checkboxes are not saved.
- **Privacy** — the page says the code is sent to the AI service to be reviewed.

## Product Decisions

- Audience is beginners and solo developers, not teams — Priyansu: "it can be for beginner but also for a solo dev."
- This project is separate from Trial Trap and Menu Shield — Priyansu's request.
- Name decided later — Priyansu: "we can always name it later."
- The following were recommended in the system design doc and accepted by Priyansu with "do it" (2026-10-07): dark theme first with a light theme; basic mode without an AI key; a suggested comment and Copy comment button on each item; pattern hints written for JavaScript, TypeScript and Python, with the AI covering any language; a second AI pass (claim check) that tries to disprove each item; the demo repo lives under Priyansu's own GitHub account with fictional names.

## What We're Building

- One web page that runs on a laptop, with Start, Loading and Results views.
- Input by public PR link, pasted diff, or the built-in sample.
- Five check areas from counted facts, pattern hints and an AI review.
- Line check and claim check, with hidden items listed and explained.
- Snippet, why, fix, where-it-came-from tag and suggested comment on each item.
- Copy Markdown, Copy comment, Download .md.
- Basic mode, all error states, the all-clear state, dark and light themes, phone width.
- A demo repo with one PR containing five planted issues, and a clean control PR.
- An evaluation script that measures planted issues found and false alarms on the clean PR.

## Deferred From the POC

- **Post as a GitHub review comment** — needs a GitHub token with write access and a sign-in flow; copying Markdown proves the value first.
- **Private repos by token** — paste-a-diff covers private code for now.
- **Custom rules** (for example "no console.log") — the rule files are built to allow it, but adding a rule editor is a second feature.
- **Whole-file context** — fetching full changed files would let breaking-change checks see more, but costs GitHub requests.
- **Saved history of past reviews** — needs storage the POC doesn't need.

## Possible Later Enhancements

- Splitting very large PRs across several AI calls so every file gets reviewed.
- One AI call per area, if the evaluation shows it finds more.
- Showing items as each one passes its checks, instead of all at the end.

## Non-Goals

- **A GitHub Action, GitHub App or VS Code extension** — each is a separate product with its own setup (cut in `scope.md > Explicitly Cut`).
- **Team accounts or team settings** — the audience is beginners and solo developers.
- **Auto-fixing code or opening PRs** — this tool helps a person review; it doesn't change code.
- **Grading or scoring the author** — the tone is a helpful colleague, not a judge.

## Open Questions

- The final name — can wait until the ship step.
- Which NVIDIA model reviews best — answered by the evaluation during the build. `meta/llama-3.3-70b-instruct` was the starting point until NVIDIA retired it in August 2026; `openai/gpt-oss-120b` followed on 2026-10-07 (HTTP 410). The app now starts with `nvidia/nemotron-3-super-120b-a12b` and switches to a working model at startup.
