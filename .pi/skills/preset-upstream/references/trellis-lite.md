# trellis-lite (clean room)

Upstream (Trellis, mini-trellis) is AGPL-3.0; pi-preset is MIT. Read upstream for behavior and file formats only. Baselines, watched paths, evaluation rules, and the decision log: `docs/trellis-lite-upstream.md`. Machine-readable baselines: `trellis-lite/upstream.json`.

## Check

- `node scripts/check-upstream-trellis.mjs` (add `--diff` for the full diff of the watched paths).
- Judge each change under the evaluation rules in `docs/trellis-lite-upstream.md`.

## Carry over

- No upstream code, comments, skill text, or template wording, not even closely paraphrased, not even in a draft.
- Describe each adopted behavior in our own words (decision-log row, plus `docs/trellis-lite-design.md` when the design changes), and implement it from that description.
- Add a log row for every reviewed change, adopted or not, with the commit column empty.
- Aim for the best result, not for compatibility. A new on-disk format follows design §8.1: no legacy readers; an `upgrade` step and a version bump in the same change, tested on old fixtures.
- Never move a baseline in `trellis-lite/upstream.json` without the user's confirmation.
