---
description: Review Trellis and mini-trellis changes since trellis-lite's baselines and draft decisions
---
Review what changed upstream for trellis-lite and draft decisions. Read `docs/trellis-lite-upstream.md` first: it has the evaluation rules and the decision log.

1. Run `node scripts/check-upstream-trellis.mjs`. For every track with commits on watched paths, read the diffs (`--diff`, or `git -C ~/.cache/pi-preset/upstream/<repo> show <commit>` per commit). Also report a new npm version or a new beta line.
2. For each upstream change, describe in your own words what behavior or format changed, then recommend adopt / partly adopt / reject, with the reason under the evaluation rules. Point out where trellis-lite has the same defect when the change is a fix.
3. Draft the decision-log rows (commit column empty) and, for anything to adopt, a behavior description that could go into `docs/trellis-lite-design.md`.
4. Clean room: do not copy or closely paraphrase upstream code, comments, skill text, or templates into this repository, not even in the draft.
5. Do not edit `trellis-lite/upstream.json` or move any baseline. Show me the draft and wait; baselines move only after I confirm.
