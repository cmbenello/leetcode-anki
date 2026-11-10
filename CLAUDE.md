# CLAUDE.md — LeetCode Anki

## What This Is

A Chrome extension (Manifest V3) that adds spaced repetition + GitHub-synced progress tracking to LeetCode/NeetCode practice. SM-2 scheduler, active time tracking, auto-commits to a user-specified GitHub repo on every grade.

**Companion to:** `grind/` (CLI focus tool). They don't share code yet, but eventually both can write to the same GitHub tracker repo.

---

## Current Phase: Phase 1 + 2 (MVP)

Phase 1 = SR loop on LeetCode (local only).
Phase 2 = GitHub auto-sync on grade.

These ship together because the GitHub sync is the differentiator vs. just using Anki.

Don't start Phase 3 (multi-site adapters), Phase 4 (categorization, FSRS), or Phase 5 (polish) until 1+2 work end-to-end on real LeetCode.

---

## Repo Structure

```
leetcode-anki/
├── SPEC.md
├── CLAUDE.md
├── CLAUDE_CODE_PROMPT.md
├── README.md                    # install + usage
├── extension/
│   ├── manifest.json            # MV3
│   ├── background.js            # service worker: SPA nav, GitHub sync queue
│   ├── content/
│   │   ├── leetcode.js          # injects on leetcode.com/problems/*
│   │   ├── inject.js            # page-context: reads window.monaco
│   │   └── widget.css
│   ├── popup/
│   │   ├── popup.html           # due-today list + stats
│   │   ├── popup.js
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html         # GitHub PAT, repo, sync toggle
│   │   ├── options.js
│   │   └── options.css
│   ├── newtab/                  # dashboard: goals, growth view, next up, due lists
│   │   ├── growth.js            # radial goal-growth canvas (pure layout + draw)
│   ├── lib/
│   │   ├── sm2.js               # scheduler (+ ease that adapts to lapses), pure
│   │   ├── model.js             # learner model + recommender, ported from Drill, pure
│   │   ├── goals.js             # goal matching/progress + Blind 75, pure
│   │   ├── phases.js            # prep phases: date windows → problems, pure
│   │   ├── dates.js             # LOCAL day keys — single source of truth
│   │   ├── storage.js           # chrome.storage wrapper
│   │   ├── github.js            # Git Data API: blob → tree → commit → ref
│   │   └── time-tracker.js      # active time (visibility + idle)
│   └── icons/                   # 16, 48, 128
└── tests/
    └── sm2.test.js              # node-runnable unit test
```

---

## Architecture Decisions

### Why Manifest V3 + vanilla JS, no build step
- The whole extension is < 1500 LOC. A build pipeline adds friction, not value.
- MV3 is required for new Chrome extensions and supported indefinitely.
- One-line install: `git clone && load unpacked`.

### Why SM-2 (not FSRS)
- ~30 lines, well-documented, "good enough" for personal use.
- FSRS needs a fitted model, which needs review history we don't have on day 1.
- Phase 4 adds FSRS as an option — opt-in once the user has 100+ reviews to fit on.

### Why SPA-aware content script
- LeetCode is a single-page React app. `chrome.scripting` only fires on full loads.
- Background worker listens to `chrome.webNavigation.onHistoryStateUpdated`, sends a `re-init` message to the content script. Content script also runs a `MutationObserver` on `<body>` as a fallback.

### Why a page-context inject script for code extraction
- Content scripts have an isolated world. `window.monaco` lives in the page world.
- We inject `inject.js` via a `<script>` tag (registered in `web_accessible_resources`), it reads `monaco.editor.getModels()[0].getValue()`, and `postMessage`s it back.
- Fallback: read from `localStorage` keys LeetCode uses (`<questionId>_<lang>`).

### Why GitHub Git Data API (not Contents API)
- Contents API = one HTTP call per file, each is its own commit. Ugly history.
- Git Data API = build a tree from blobs, one commit, one ref update. Clean history, atomic.
- Per grade event: ~5 files (solution, meta, notes maybe, log, README, stats). One commit.

### Storage shape
```js
// chrome.storage.local["cards"]
{
  "two-sum": {
    slug: "two-sum",
    title: "Two Sum",
    ease: 2.5,
    interval: 6,            // days
    reps: 3,
    lapses: 0,
    due: 1746000000000,     // ms epoch
    history: [
      { t: 1745000000000, q: 4, durationMs: 320000, lang: "python3" },
      ...
    ]
  },
  ...
}

// chrome.storage.local["settings"]
{
  githubToken: "ghp_...",
  githubRepo: "user/leetcode-tracker",
  syncEnabled: true,
  defaultLang: "python3"
}
```

---

## Working Here

- Read `SPEC.md` and `CLAUDE_CODE_PROMPT.md` at session start.
- Stay in Phase 1+2 until both checklists are done.
- Run `npm test` (scheduler, learner model, goals) before wiring changes to UI.
- Day keys are LOCAL time and come only from `lib/dates.js`; never `toISOString().slice(0, 10)`.
- Never assume card records are well-formed: `getCards()` normalises them (`lib/cards.js`) because one bad record used to break every dashboard request. New-tab sections load independently and show their own errors; don't chain them.
- Submission verdicts come from the judge endpoint via `content/inject.js`; the DOM observer is a fallback only.
- `lib/model.js` mirrors Drill (`~/Coding/embed/src/embed/engine.py`); keep constants in sync and cite the experiment.
- A logged `pPred` must be the prediction as of the attempt's START (`factors.startedAt`), from earlier attempts only — the attempt's own verdict is stored before the grade and would otherwise leak in. Only `pPredV: 2` entries are trusted; `tests/background.test.js` guards this.
- The rating card's 1–4 is how hard a solve FELT (1 easy … 4 hard), stored as `perceived` on the history entry. It is never a miss: every rated solve counts as solved, and the review timer just follows it. The predictor uses it as Elo partial credit (`PERCEIVED_SCORE` in `lib/model.js`). That weighting is extension-only and uncalibrated; it's in the Drill export so Drill can fit it.
- While the rating card is up it owns 1–4, S and Esc even when the cursor is in the code editor (focus is usually still there after Submit). It catches them on `window` in the capture phase and calls `preventDefault`, which is what stops Monaco typing the digit; don't add a "skip if typing" check back.
- Topic arcs come from `lib/topics.js`. A problem NeetCode lists goes in NeetCode's roadmap category; anything else goes by its tags, ranked so trees beat graphs (DFS/BFS tags) and linked lists beat two pointers. The graph and the recommender both use it; don't classify topics anywhere else.
- Subtopics come from `lib/subtopics.js`: per topic, ordered tag rules (first match wins, the last entry is the catch-all), picked from catalog tag counts and pinned by `tests/subtopics.test.js` against well-known problems. The opened-topic graph, strength and the recommender all use it.
- Topic strength (`lib/strength.js`) is the model's chance on a typical Medium, replayed with each attempt counting toward its topic/subtopic alone (shared tags like `array` blurred weak topics into their neighbours) and scored by how cleanly it went (`cleanScore`: retries before Accepted, felt difficulty, hints). With every Accepted a full win, Elo just climbs with each solve and strength turns into a count. It's a display metric; the recommender still uses per-tag ability and binary wins. The graph shows it only as dot brightness/saturation per arc, scaled across your own topics in log-odds (a length reads as quantity, a glow was too loud, and an absolute scale painted a clean history's 80–87% topics all alike).
- Prep phases (`lib/phases.js`) group problems by LOCAL first-solve day. The repo is public: a personal timeline lives only in chrome.storage or the git-ignored `data/phases.local.json`, never in source or tests.
- Anything toggled with the `hidden` attribute relies on the global `[hidden] { display: none !important; }`. Theme rules set `display` and used to out-rank `[hidden]`.
- Manual test loop: load unpacked → visit `leetcode.com/problems/two-sum` → grade → check `chrome.storage.local` in DevTools → check GitHub repo for commit.
- Don't add a build step. If you want TypeScript, write `.js` with JSDoc types.
- Mark `SPEC.md` checklist items with `[x]` when done.
