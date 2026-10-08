# Polish log

A running log of small fixes to the local web app (the tour at `/` and the app at `/app`).
Each pass starts with an audit list, then each item is fixed one at a time and marked here
with what changed and how it was checked. Newest pass at the top.

## Pass 2 · 2026-10-08 · final code review

Part of the build's final review. Two reviewers read every file: one the server and `lib/`,
one the page (`public/`). Each finding was reproduced (a timed script, a Playwright run, or a
stubbed review full of hostile text) before it was fixed, and re-run after. No XSS was found:
text from a PR or the AI never becomes HTML, and the Markdown export neutralises `<`, links and
@mentions.

| # | Where | What was wrong | Status |
|---|-------|----------------|--------|
| 1 | Pattern hints | One very long added line (80,000 characters of `WHERE WHERE …`) made the SQL and loop patterns take seconds; a 1 MB paste could freeze the server for minutes. | fixed |
| 2 | AI prompt | A file bigger than the AI's size limit was dropped whole, yet the empty areas still said "looks good", and a PR made of one huge file sent the AI an empty diff. | fixed |
| 3 | Startup | With port 3000 already taken, it printed "running at http://localhost:3000" before the "port in use" message (Express 5 calls the listen callback with the error). | fixed |
| 4 | Samples | `{"sample":"constructor"}` got past the sample-name check and gave "Something went wrong" instead of "There is no sample with that name." | fixed |
| 5 | GitHub | A README that timed out failed the whole review, and an empty README from a GitHub hiccup stayed in the 10-minute cache. | fixed |
| 6 | Links | Links for removed lines point at the PR's base commit; if the base branch changed that file after the PR branched, the line number can be off. | known, left as is |
| 7 | Pop-up | Keyboard focus wasn't returned to the button that started a review (a disabled button loses focus). | fixed |
| 8 | Pop-up | Retry on a fallback review re-ran the last attempted PR, not the one it was shown on. | fixed |
| 9 | Pop-up | Tab could escape the pop-up after clicking plain text, after Retry, or after "Show all". | fixed |
| 10 | Copy comment | The copied comment kept @mentions, so pasting it could notify people or teams. | fixed |
| 11 | Pop-up | Opening `/app?sample=1` and clicking "Try the example PR" quickly ran two reviews that fought over the pop-up and left a timer running. | fixed |
| 12 | Markdown | Python names like `__init__` came out in italics. | fixed |
| 13 | Pop-up, phones | A long file path pushed the pop-up sideways at 375 px. | fixed |
| 14 | Both | Several greys were below the 4.5:1 contrast minimum (the small note under the link box was 2.3:1). | fixed |
| 15 | Pop-up | Screen readers would read the seconds counter out every second, but never the step names. | fixed |

### Fixes

1. `lib/hints.js`: lines over 1,000 characters (minified or generated code) are skipped by the
   pattern checks (`MAX_HINT_LINE`). Checked: the 80,000-character line now takes no time, and a
   worst-case 1 MB paste of 999-character lines takes 0.4 s instead of minutes.
2. `lib/prompt.js`: the first file that doesn't fit is read in part, whole lines up to the
   limit, ending with "[the rest of this file was cut to fit]". `lib/review.js`: if the AI could
   read nothing, it isn't asked and the review says why; when anything was cut, empty areas
   show "part read" instead of "looks good", and the note names the partly read file.
3. `server.js`: the listen callback returns early when it gets an error. Checked: with the port
   held, only "Port … is already in use" is printed.
4. `lib/review.js`: sample names are looked up with `Object.hasOwn`.
5. `lib/github.js`: README problems return an empty README and the PR isn't cached, so the
   next try reads it again; a README that doesn't exist (404) is still cached as empty.
6. Not changed: a link to GitHub's "Files changed" tab would need GitHub's own file anchors,
   which couldn't be checked from here, and new-line links (most items) aren't affected.
7–9, 11. `public/app.js`: the opener is remembered before buttons are disabled; focus goes
   back to it, or to the link box if it's still disabled; Tab and Shift+Tab treat focus on the
   card or outside it as the edge; Retry moves focus to Cancel and "Show all" to its chip; a
   review replaced by a newer one no longer touches the page; the timer is cleared before a new
   one starts; Retry uses the request that made the review on screen (`state.reviewBody`).
10. `public/markdown.js`: `quietMentions` puts each @name in code, used by Copy comment.
12. `public/markdown.js`: runs of underscores at a word's edge are escaped one by one.
13. `public/styles.css`: file paths in "What was checked" and hidden items wrap anywhere.
14. `public/styles.css`: paper greys are now `#666863` (4.95:1); in the pop-up `--faint` is
    `#858e9b` (5.6:1), `--muted` `#a2abb7`, and the small label uses the light blue.
15. `public/app.html`: the seconds counter is hidden from screen readers and a hidden status
    line announces each step.

Checked together: `npm test` (137 pass, 8 new tests for items 1, 2, 4, 5, 10 and 12), the
reviewers' Playwright scripts re-run (focus, Tab, Retry, overlap, long paths, contrast, no
page scroll at 375 to 1920 px), and screenshots of the app and the pop-up.

## Pass 1 · 2026-10-08

Asked by Priyansu: "there are some here's and there's in the local web app, patch those up.
Make a list, move step by step, keep a log."

How the audit was done: the app ran locally in basic mode (no AI key) and a script drove a
headless Chromium at desktop (1440x900) and phone (390x844) size through every state: the
tour from top to bottom, the app's empty-link and bad-link errors, paste-a-diff mode and its
error, the sample review (loading, results, filters, "What was checked", Copy Markdown),
closing and reopening the review, Start over, keyboard focus, and a few odd addresses
(`/nope`, `/app/`, `/app.html`). Console errors and failed requests were collected.

### The list

| # | Where | What's wrong | Status |
|---|-------|--------------|--------|
| 1 | Tour | The selected tab in the top menu keeps dark text on its coloured background (red for Security, orange for Breaking), so it's hard to read. | fixed |
| 2 | App | `/app/` (with a slash at the end) loads with no styles and no script, because the page asks for `styles.css` and `app.js` relative to the address. | fixed |
| 3 | Both | Any unknown address shows Express's bare "Cannot GET /nope" page. | fixed |
| 4 | App, phones | A tapped button keeps its hover look (the black "Review it" turns blue and lifts), because phones keep `:hover` after a tap. | fixed |
| 5 | App, phones | The top menu is hidden on phones, so there is no way back to the tour. | fixed |
| 6 | Both | Three slightly different blues in the browser-tab icons (`#3b6fe0` on the tour, `#3b82f6` on the app) instead of the brand blue `#2f5fd0`. | fixed |
| 7 | README | Still says to click **Try a sample**; the app's button is now **Try the example PR**. | fixed |
| 8 | App CSS | `.item-detail` styles are left over from an older layout and nothing uses them. | fixed |
| 9 | App hero | The "01 read the diff" note sits on top of the code preview's "FILES" label. | fixed |
| 10 | App hero | The "02 find the gap" note covers the end of code line 15, and at 800 px wide it's cut off at the right edge. | fixed |
| 11 | App hero | The round "every item points at a line" stamp is clipped at the right edge at 800 to 1134 px wide, and on phones it covers the preview's footer text. | fixed |
| 12 | App, phones | The grey offset shadow behind the code preview sticks out as a slab on the right. | fixed |
| 13 | App hero | At about 1134 px wide the link box is narrow, so its example text is cut off ("…/repo/pul"). | fixed |
| 14 | App | The three "How it works" rows each show a ↗ arrow but aren't links. | fixed |
| 15 | App | "Start a review ↗" only jumps up the same page: the ↗ suggests an outside link, and the cursor isn't put in the link box. | fixed |
| 16 | App | After "Start over", the cursor isn't put back in the link box. | fixed |
| 17 | Tour | The browser warns that `world/start.webp` is preloaded but not used within a few seconds. | fixed |
| 18 | App | After a review that fails straight away, the hidden pop-up can keep its "open" style, so the next opening skips its fade. | fixed |

Items 9 to 18 came from a second check on Priyansu's PC, in a real browser at 800, 1134 and
375 px wide with the AI reviewer on. It also confirmed: a PR that doesn't exist shows "Couldn't
open that PR" with a link to paste the diff, Copy Markdown falls back to showing the text when
the browser blocks the clipboard, and `/app?sample=1` from the tour works.

Checked and fine: no console errors on either page, no failed requests on normal pages, both
pages fit the phone width with no sideways scroll, the bad-link and not-a-diff errors read
clearly, Esc closes the review, "Open the last review" brings it back, Start over clears it.

### Fixes

Each fix was checked in headless Chromium after the change; all 129 tests pass (two new ones
for items 2 and 3).

1. **Tour tab text.** `public/index.html`: `.sw-nav .sw-nav__item.is-active { color: #fff; }`.
   The page's own `.sw-nav__item` colour was overriding the engine's white. Checked: the
   selected tab reads white on green, red and orange.
2. **`/app/`.** `public/app.html` loads `/styles.css` and `/app.js` from the site root.
   Checked: `/app/` is styled and the pill loads; test `the app page loads its files from the
   site root`.
3. **Unknown addresses.** New `public/404.html` in the paper style with "Open the app" and
   "Take the tour"; `server.js` sends it for unknown pages and a JSON `not-found` error for
   unknown `/api/` calls. Checked at desktop and phone size; test `unknown addresses get the
   friendly page`.
4. **Sticky hover on phones.** `public/styles.css`: a `@media (hover: none)` block resets the
   hover looks of the buttons, links, method rows and area chips. Checked with an iPhone 13
   profile: after a tap the button stays black with no lift.
5. **No way back to the tour on phones.** A "Tour ↗" link in the top bar, shown only when the
   menu is hidden (700 px and under). Checked on the phone profile.
6. **Tab icons.** Both pages and the 404 page use `#2f5fd0`.
7. **README.** Names **Try the example PR** (app) and **Try the sample** (tour).
8. **Dead CSS.** Removed `.item-detail`.
9. and 10. **Notes on the code preview.** The three notes now sit outside the editor: "01 read
   the diff" and "02 find the gap" above it, "03 make it actionable" below. Checked at 800,
   1134 and 1440 px: nothing covers code or labels, nothing is cut off.
11. **Stamp.** At 1340 px and under it moves in and down (`right: -14px; bottom: -26px`), so
   its right edge stays inside the window (782 px at 800 wide, 1116 at 1134); hidden on
   phones, where there is no room for it. Re-check on the PC found it still covered
   "· docs · perf" in the preview's footer at 800 and 1134 px, so the footer now has 84 px of
   right padding (16 px on phones, where the stamp is hidden). Checked: the whole footer line
   reads at 800, 1000, 1134, 1280, 1440 and 1920 px.
   Follow-up (Priyansu: "go on and fix these"): at 800 px the text ended exactly at the stamp's
   edge. Now, at 1000 px and under (one-column layout), the stamp sits just below the preview
   instead of over its footer (`bottom: -84px`, 7 px clear), and above 1000 px the footer's
   right padding is 100 px, leaving a 16 px gap at 1134 px. Measured at 720, 800, 1000 and
   1134 px: no overlap, no sideways scroll.
12. **Shadow slab on phones.** On phones the editor keeps only its soft shadow.
13. **Cut-off example text.** The link box's example now reads `github.com/owner/repo/pull/123`,
   which fits at 1134 px. Full `https://` links still work.
14. **Arrows on rows that aren't links.** Removed the ↗ from the three "How it works" rows.
15. **"Start a review".** Its arrow is now ↑ (it goes up the page, not out), and clicking it
   scrolls to the top and puts the cursor in the link box (or the diff box in diff mode).
16. **Start over.** Shares the same `focusInput()` helper. Checked at all three widths: the
   cursor is in the link box at the top of the page.
17. **Preload warning.** Removed the unused `world/start.webp` preload from the tour. Checked:
   no warnings after 5 s on the tour.
18. **Pop-up "open" style after a fast failure.** The fade-in is only added if the pop-up is
   still open when the next frame runs.
