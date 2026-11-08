# LeetCode Anki — Project Spec

**Category:** Practical / Fun
**Stack:** Chrome Extension (Manifest V3), vanilla JS/HTML, no build step
**Companion to:** `grind/` (CLI focus tool) — eventually share data via the GitHub sync repo

---

## Concept

A Chrome extension that turns LeetCode practice into spaced repetition. Solve a problem, grade it (Again / Hard / Good / Easy), and the SM-2 scheduler picks the next due date. The extension auto-commits each review to a GitHub repo: solution snapshot + review log + dashboard. Over time the repo becomes a living portfolio of your DSA practice with provable, dated evidence of progress.

The point is to (a) stop re-solving the same easy problems and (b) actually have an artifact at the end of months of grinding.

---

## Phases

### Phase 1 — MVP loop (now)
- [x] Manifest V3 extension scaffold + icons
- [x] Content script injects on `leetcode.com/problems/*`
- [x] Floating widget with 4 grading buttons (Again / Hard / Good / Easy)
- [x] SM-2 algorithm in `lib/sm2.js` with unit test
- [x] `chrome.storage.local` keyed by problem slug
- [x] Active time tracking (pause on tab blur, stop on grade or unload)
- [x] SPA navigation handling (LeetCode is a SPA — re-inject on `history.pushState`)
- [x] Popup shows "Due today" list with click-to-open + counts (due / new / total)
- [x] Options page for settings

### Phase 2 — GitHub sync (also in MVP because it's the differentiator)
- [x] Options page captures PAT + `user/repo`
- [x] On grade event: commit solution code + meta.json + log line + regenerated README dashboard
- [x] Solution extraction from Monaco editor (page-context script reading `monaco.editor.getModels()`)
- [x] Single-commit batching (one git commit per grade, multiple files via Git Data API)
- [ ] Repo layout:
  ```
  <user>/<repo>/
  ├── README.md           # auto-generated dashboard: due today, streak, totals
  ├── log.md              # chronological review log
  ├── stats.json          # aggregates
  └── solutions/<slug>/
      ├── solution.<ext>  # latest code from editor at grade time
      ├── meta.json       # SR state + history
      └── notes.md        # editable, optional
  ```

### Phase 3 — Multi-site (later)
- [ ] Adapter pattern: `extension/sites/<host>.js` exports `{ matches, getSlug, getCode, getLanguage, getTitle }`
- [ ] NeetCode (mostly redirects to LC, but its own problem viewer too)
- [ ] HackerRank, Codeforces

### Phase 4 — Categorization + better SR (later)
- [x] Auto-fetch difficulty + topic tags via LeetCode GraphQL
- [x] Show difficulty/tags in popup
- [ ] Filter popup by tag, see "due today: arrays + dp"
- [ ] Concept-level SR: tag a `xor-invariant` mistake, resurface that *concept* via different problem
- [ ] FSRS algorithm option (more accurate than SM-2)

### Phase 5 — Mistake / error analytics
- [x] Detect submission outcome (Accepted / Wrong Answer / TLE / MLE / RE / CE / OLE)
- [x] Per-problem error stats: AC/WA/TLE/RE/CE counts in popup + per-problem README
- [x] Tag-level aggregation: per-site README shows "Trouble tags" ranked by AC rate
- [ ] Capture failed test case (input + expected + actual) on Wrong Answer via DOM scrape
- [ ] LLM-categorize WA cases into root-cause buckets
  (off-by-one, missed edge case, wrong complexity, hash-collision, etc.)
- [ ] Surface "you commonly make X logic error" insights in popup + README

### Phase 6 — Polish (later)
- [x] Streak tracking (new-tab page)
- [x] Keyboard shortcuts (1/2/3/4 grade)
- [x] Export/import JSON
- [x] Customisable interval defaults (per-button base + growth multiplier)

### Phase 7 — Goals + learner model (Drill integration)
- [x] Goals: topics / fixed list (Blind 75 preset) / pasted list / everything, with deadline pace
- [x] Radial goal-growth view on the new-tab page (angle = topic, radius = progress to goal)
- [x] Verdicts from LeetCode's judge endpoint (not DOM text): Run excluded, deduped by submission id, pinned to the submitting slug
- [x] Attempt factors: peeks, hints, fails before AC, time to AC; ungraded/abandoned sessions counted
- [x] Learner model ported from Drill (`lib/model.js`): Elo per topic, E26 recall bonus, E24 variant timing
- [x] "Next up" recommendations over the full LeetCode catalog, with prediction + evidence
- [x] Calibration readout; `drill/attempts.jsonl` export in Drill's schema
- [ ] Refit the cold-start difficulty prior from real attempts once there are enough
- [ ] Drill-side importer for `drill/attempts.jsonl`

---

## Key Concepts to Understand Deeply

- **SM-2 algorithm:** the original SuperMemo scheduler. Per-card state is `{ ease, interval, reps, lapses, due }`. Quality 0–5 maps to button presses. Ease floor at 1.3 prevents cards from spiraling.
- **Manifest V3 service workers:** unlike MV2 background pages, MV3 service workers are killed after ~30s idle. Persistent state must live in `chrome.storage`, not module-level vars. Wake-up on events (alarms, messages, navigation).
- **SPA navigation in content scripts:** content scripts only fire on full page loads. LeetCode's React router uses `history.pushState`, which doesn't trigger them. Solution: listen to `chrome.webNavigation.onHistoryStateUpdated` from the background worker and re-message the content script.
- **Page-context vs content-script context:** content scripts can't access page globals (e.g. `window.monaco`). Inject a `<script>` tag whose `src` is a packaged extension file (registered in `web_accessible_resources`), then use `postMessage` to ferry data back.
- **GitHub Git Data API:** to commit multiple files in a single commit, you create a tree from blobs, then a commit pointing at that tree, then update the ref. PATs need `repo` scope.

---

## Interview Depth Questions

Be ready to answer all of these:

1. Why SM-2 vs FSRS? What does FSRS model better, and why is that worth the implementation cost (or not)?
2. How do you keep state consistent when the MV3 service worker dies mid-operation?
3. Why can't a content script just call `window.monaco.editor.getModels()` directly?
4. How does the GitHub Git Data API differ from the Contents API, and why does it matter for batched commits?
5. Time tracking: what's "active time" and how do you measure it without a heartbeat? (Page Visibility API + idle detection)
6. If you wanted to support a non-Monaco editor (e.g. Codeforces' textarea), how would the adapter pattern need to change?
7. How would you migrate this from per-problem SR to concept-level SR without losing existing review history?
8. The PAT lives in `chrome.storage.local`. What are the exfiltration risks and what would you do for a real shipped extension?

---

## What Success Looks Like

**Phase 1+2 complete:**
- [ ] Install via "Load unpacked", visit a LeetCode problem, see the widget
- [ ] Grade a problem, see it in popup's "Due today" list with correct interval
- [ ] Grade a problem, see a new commit in your GitHub tracker repo with solution code
- [ ] Re-grade after the interval, see the review history grow in `solutions/<slug>/meta.json`
- [ ] README.md in tracker repo shows up-to-date dashboard

**Stretch (won't block phase complete):**
- [ ] Used personally for 14 consecutive days
- [ ] 50+ problems in the SR rotation
- [ ] At least one "I forgot this trick" caught by the SR scheduler

---

## Non-Goals (don't build these in v1)

- Build tooling (webpack, vite, wxt) — MV3 + vanilla is plenty
- React or any UI framework — popup and options are <200 lines each
- Cloud sync via a backend — GitHub repo IS the backend
- Chrome Web Store publication — load unpacked is fine for personal use

## Ideas for later (noted Nov 7, 2026 — not started)

Three directions to pick up later, in roughly this order. Each line in quotes is the original ask.

1. **Beyond LeetCode.** "Expand this to stuff that isn't LeetCode."
   Problems are keyed by LeetCode slug and the content script only knows LeetCode/NeetCode pages. Generalise to a source-agnostic "problem" (id, source, topics, difficulty, attempts) so other practice can feed the same rings, phases, stars and scheduler: the quant drills (`content/quant.js` already exists), interview-style math/probability, system design, concept cards.

2. **Better-integrated prediction.** "Better integrate the prediction."
   Today the learner model (`lib/model.js`, ported from Drill) only ranks *Next up* and logs `pPred`. Use it everywhere a decision is made: show the predicted solve chance on the rating card and in topic suggestions, let it drive review timing alongside or instead of SM-2, calibrate it against the 1–4 difficulty you give, and make goals/phases ask "what raises my odds for *this* interview".

3. **Understanding and generating the problem state.** "Better have an understanding of generating the problem state itself."
   Model the problem space itself rather than treating problems as opaque ids: what each problem requires (patterns, prerequisite skills, the trick), how problems relate, and where you stand on each. Then generate from that state, e.g. new variants or targeted practice problems at the right difficulty for your weakest skill instead of only picking from LeetCode's catalog.
