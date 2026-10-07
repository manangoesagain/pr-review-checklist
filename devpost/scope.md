---
doc: scope
status: approved
---

# PR Review Checklist (name to be decided)

"Senior Dev in Your Pocket": paste a GitHub pull request link and get the checklist a careful senior reviewer would run, with every item pointing at the exact file and line in that PR.

## The Unique Kernel
Every checklist item **proves itself**: it shows the real lines from the PR's diff that it's about, the app hides anything the AI can't back up with a line that actually exists, and a second check tries to disprove each remaining claim against its code. Each item also says **why it matters** in one plain sentence, so the checklist teaches you what to look for instead of just grading the code. Automatic PR review bots already exist for teams; this is a pocket reviewer you can trust and learn from.

## Who It's For
Two people, one app:
- **A beginner** reviewing a classmate's or an open-source PR who doesn't yet know what a senior reviewer looks for.
- **A solo developer** with no one to review their code, checking their own PR before merging or asking for review.
In Priyansu's words: "You know the checklist mentally, but you forget, you rush, you're tired." Today they skim the diff and hope they didn't miss tests, docs, a breaking change, a slow query or a security hole.

## The Core Loop
Open the page → paste a PR link (or paste a diff for private code) → see "Analyzing…" → get a checklist across five areas (tests, breaking changes, docs, performance, security), each with a file:line, the code snippet and why it matters → copy it as Markdown into the PR or their notes → come back with the next PR.

## Inspiration & Identity
A senior engineer who's on your side: calm, direct, specific. Looks professional ("pro look"), more like a polished developer tool than a toy. A proposed layout is in the system design doc; details are settled in `3-prd`.

## Why This Matters to the Learner
Every PR review misses something, and Priyansu wants to learn prompt engineering for structured reasoning, the GitHub API and diff parsing, and how to ship a "thin wrapper, thick prompt" product.

## What "Working" Looks Like
Paste the link to a demo PR → a few seconds of "Analyzing…" → a checklist appears, for example:
- ☐ Tests added for new logic? 3 files changed, 0 test files
- ☐ Breaking change? API response shape modified in users.ts:42
- ☐ Docs updated? README still shows v1 endpoints
- ☐ Perf? Possible N+1 query in getUserOrders, line 88
- ☐ Security? Raw SQL interpolation in search.ts:15
Each item shows the actual code it points to. Click "Copy Markdown" and paste it into the PR.
**The "oh, that's cool" beat:** the app catches the raw SQL line a rushed reviewer would skim past, and shows the exact line to prove it.

## The POC Boundary
- One web page that runs on a laptop.
- Input: a public GitHub PR link, or a pasted diff as the fallback.
- Five check areas: tests, breaking changes, docs, performance, security.
- Simple facts counted by plain code (files changed, test files changed, README touched) and pattern hints; judgment from the AI.
- Items may only point at lines the PR changed (plus the few unchanged lines shown around them). Every item is verified against the real diff, then a second AI pass tries to disprove it; anything unprovable or rejected is hidden, with the reason available. Honest "nothing found" results.
- The PR's README is fetched as extra context, so the docs check can see what the README says.
- Basic mode: with no AI key, or if the AI fails, facts and hints still produce a clearly labeled checklist.
- Copy as Markdown.
- A demo repo under your own GitHub account with one PR that has planted issues, using fictional names.
- Small and medium PRs only (up to about 50 files); a clear message when a PR is too big.

## Later
- "Post as review comment" on GitHub (needs a GitHub token).
- Custom rules, such as "no console.log" or "feature flag required".
- Private repos through a GitHub token.

## Explicitly Cut
- **GitHub Action that runs on every PR.** A stretch goal in the pitch, but it's a second product with its own setup; the web page proves the idea.
- **VS Code extension.** Same reason, and extension packaging is a lot to learn solo for one demo.
- **Team accounts and team config.** The audience is beginners and solo devs, not teams.

## Approval Notes
Approved 2026-10-07 by Priyansu ("do it"), together with the recommendations in the system design doc: dark theme first with a light theme, basic mode without an AI key, a suggested comment on each item, pattern hints for JavaScript/TypeScript/Python, name decided later.
