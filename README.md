# LeetCode Anki

Chrome extension that adds Anki-style spaced repetition to LeetCode and auto-commits your progress to a GitHub repo.

- After an Accepted, a small corner bar asks *how hard was it?* Rate 1 (easy) to 4 (very hard), by click or key. Spaced repetition does the rest and adapts to lapses
- Verdicts read from LeetCode's own judge response, so Run results, stale history and quick problem switches can't be misrecorded
- Goals ("Google interview", Blind 75, your own list) shown as a radial growth view on the new-tab page
- "Next up" recommendations from a learner model ported from Drill (`~/Coding/embed`), each shown with its predicted solve rate and the evidence behind it
- Per-attempt factors: active time (reading vs coding), failed submissions before AC, editorial/solution peeks, hints, time to AC
- Auto-commits one commit per grade (solution + meta + dashboards + `drill/attempts.jsonl`) to a GitHub repo of your choice
- Local-first: everything lives in `chrome.storage.local`; GitHub sync is additive

## Install

1. Clone this repo
2. `chrome://extensions` → enable Developer mode → "Load unpacked" → select the `extension/` folder
3. Click the extension icon → Options → paste a GitHub Personal Access Token (`repo` scope) and your tracker repo as `username/repo`
4. Visit any `https://leetcode.com/problems/<slug>/` page and grade your attempt

## Goals and recommendations

Open a new tab. Click **+ set a goal** and pick a goal type:

- **Topics**: e.g. "Prepare for Google interview" with a target count and an optional deadline. You'll see the pace you need.
- **Blind 75**: the fixed list.
- **My list**: paste problem links.
- **Everything**.

Each solved problem is a leaf. Angle is its topic. Distance from the centre is how far you are toward the goal, and the growth reaches the dashed goal ring at 100%. Brighter leaves are recent, and a warm ring means due for review. Click a pill to switch goals, or click the active pill to edit it.

**Next up** ranks unseen problems from LeetCode's catalog (refreshed weekly) with Drill's model:

- 1-D Elo ability per topic.
- A recall bonus on re-attempts that never inflates ability.
- Near variants of recent misses, offered after an hour and within a week, using LeetCode's curated *Similar Questions*. They're only offered if you're likely to pass them.
- A target of about 75% success.

`lib/model.js` documents every constant and the Drill experiment it comes from. The footer reports whether past predictions were honest.

## Importing your history

Options → **Import LeetCode history** pulls every submission from your LeetCode account using your existing login, so sign in to leetcode.com in Chrome first. It runs inside a LeetCode tab, opening one in the background if needed.

- Imported solves count toward goals and fill in the growth view and the daily tracker. The recommender learns from them too.
- Imported problems join your reviews a few a day (5 by default), longest-ago first, instead of all at once.
- Re-running only adds what's new.

## NeetCode

Your NeetCode progress syncs automatically. Open neetcode.io while logged in and visit any practice list. A small read-only script on neetcode.io reads the completed list NeetCode keeps in your browser. Those entries are LeetCode slugs, so they map onto the same problems.

NeetCode doesn't record dates, so synced problems form the trunk at the centre of the growth view and stay out of the daily tracker.

- Goals can track **NeetCode 150** and **NeetCode 250** directly.
- Next up links each problem to its NeetCode page.
- Options → *Open problems on* chooses whether clicks go to LeetCode or NeetCode.
- The list data is bundled in `extension/data/neetcode.json`. Refresh it with `node scripts/update-neetcode.mjs`.

## The new-tab page

It's deliberately minimal: your goal pills, a large ring graph of your solved problems on flat grey, and a faint ⚙ in the corner.

How to read the graph:

- **Rings** are difficulty: Easy inside, Medium in the middle, Hard outside. Each ring is one layer of evenly spaced dots.
- **Arcs** are topics. A dot's colour is its topic, brighter where you've solved more.
- **Lines** mean "built on". Each problem connects to the earlier problem in its topic it's most related to: a LeetCode *similar question* first, otherwise shared topics and NeetCode pattern. Along an arc, problems follow that tree, so a problem sits beside the one it built on, even on another ring. Faint lines through the middle link problems that span topics. Hover a problem to see what it grew from and why.
- **Phases** sit under the graph (e.g. "Company A 2026 · Company B 2026 · Unstructured"). Pick one to light up the problems you first solved during it; the rest fade but keep their places. Set phases in Options → *Prep phases*. Anything outside a phase, or solved only on NeetCode (no dates), is *Unstructured*. To seed them on first run without committing your own timeline, copy `extension/data/phases.example.json` to `phases.local.json` (git-ignored).

Below the graph are the daily tracker, stats, Next up and your problem lists.

- **Zoom** the growth view with a pinch or ⌘/Ctrl+scroll.
- **Drag** to pan, **double-click** to zoom in, and use ⤢ to reset.
- Plain scrolling still scrolls the page.

Colours come from theme tokens in `newtab/newtab.css`.

## Problem catalog

`extension/data/catalog.json` is a bundled snapshot of LeetCode's ~4,100 problems, so recommendations work the moment the extension is installed. The background refreshes it weekly, which takes about 5 seconds. To regenerate the snapshot:

```bash
node scripts/update-catalog.mjs
```

## How the GitHub repo gets organized

```
<your-tracker-repo>/
├── README.md             # auto-generated dashboard (due today, streak, totals)
├── log.md                # chronological review log
├── stats.json            # aggregate counts
├── drill/attempts.jsonl  # every attempt in Drill's `attempts` schema
└── <site>/<slug>/
    ├── solution.<ext>    # latest editor contents at grade time
    ├── meta.json         # SR state + full grade history
    └── notes.md          # editable, optional
```

Every grade is one commit. Commit message format: `<site>/<slug>: <button> (<old interval> → <new interval>)`.
An Accepted verdict you never graded is committed by an hourly sweep after 30 minutes.

## Tests

```bash
npm test     # scheduler, learner model, background flows, growth layout, prep phases
```

## Project layout

See `SPEC.md` for phases and `CLAUDE.md` for architecture.
