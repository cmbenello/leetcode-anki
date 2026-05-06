# Claude Code session starter — LeetCode Anki

Paste this at the start of a new session.

---

You're working on `leetcode-anki/`, a Manifest V3 Chrome extension that adds Anki-style spaced repetition to LeetCode + auto-commits progress to a user-specified GitHub repo.

Read these in order before doing anything:
1. `SPEC.md` — phases and success criteria
2. `CLAUDE.md` — architecture, storage shape, current phase

Current phase: **Phase 1 + 2 (MVP)**. Don't touch Phase 3+ features yet.

Conventions:
- Vanilla JS/HTML, no build tooling, no frameworks
- All state in `chrome.storage.local` (the service worker dies; module-level vars don't survive)
- SM-2 scheduler, 4-button grading: Again / Hard / Good / Easy
- Single GitHub commit per grade event via Git Data API (blob → tree → commit → ref)
- Mark SPEC.md checklist items `[x]` when done

Manual test loop:
1. `chrome://extensions` → "Load unpacked" → select `extension/`
2. Visit `https://leetcode.com/problems/two-sum/`
3. Widget appears bottom-right with grade buttons
4. Grade → check storage in DevTools → check tracker repo for new commit

If GitHub sync fails, surface the error in the widget; never lose review state because of a network error.
