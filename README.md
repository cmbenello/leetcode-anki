# LeetCode Anki

Chrome extension that adds Anki-style spaced repetition to LeetCode and auto-commits your progress to a GitHub repo.

- 4-button grading (Again / Hard / Good / Easy) with SM-2 scheduling
- Active time tracking per attempt
- Auto-commits solution + review log + dashboard to a GitHub repo of your choice
- Local-first: review state lives in `chrome.storage.local`, GitHub sync is additive

## Install

1. Clone this repo
2. `chrome://extensions` → enable Developer mode → "Load unpacked" → select the `extension/` folder
3. Click the extension icon → Options → paste a GitHub Personal Access Token (`repo` scope) and your tracker repo as `username/repo`
4. Visit any `https://leetcode.com/problems/<slug>/` page and grade your attempt

## How the GitHub repo gets organized

```
<your-tracker-repo>/
├── README.md             # auto-generated dashboard (due today, streak, totals)
├── log.md                # chronological review log
├── stats.json            # aggregate counts
└── solutions/<slug>/
    ├── solution.<ext>    # latest editor contents at grade time
    ├── meta.json         # SR state + full grade history
    └── notes.md          # editable, optional
```

Every grade is one commit. Commit message format: `<slug>: <button> (interval Nd → Md)`.

## Project layout

See `SPEC.md` for phases and `CLAUDE.md` for architecture.
