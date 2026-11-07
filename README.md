# LeetCode Anki

Chrome extension that adds Anki-style spaced repetition to LeetCode and auto-commits your progress to a GitHub repo.

- 4-button grading (Again / Hard / Good / Easy — or press 1–4) with spaced repetition that adapts to lapses
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
npm test     # scheduler + learner model + goals
```

## Project layout

See `SPEC.md` for phases and `CLAUDE.md` for architecture.
