# trellis-lite: following upstream

trellis-lite is a clean-room rewrite. Trellis and mini-trellis are AGPL-3.0, pi-preset is MIT, so nothing is merged or copied: upstream is read to learn about behavior and file formats, the change is described here in our own words, and it is implemented from that description.

## Baselines

The machine-readable copy is [`trellis-lite/upstream.json`](../trellis-lite/upstream.json); `scripts/check-upstream-trellis.mjs` compares against it.

| Upstream | Track | Baseline | npm | Date |
|---|---|---|---|---|
| [mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis) | `feat/v0.7-beta` | `v0.7.0-beta.4` `be9e19b` | `beta` 0.7.0-beta.4 | 2026-09-11 |
| Trellis | `main` | `v0.6.17` `833a584` | `latest` 0.6.17 | 2026-09-11 |
| [Tiger-zzZ/mini-trellis](https://github.com/Tiger-zzZ/mini-trellis) | `main` | `74f2dfa` | `latest` 0.2.0 | 2026-10-04 |

## Watched paths

- Trellis: `packages/cli/src/templates/pi/`; the update-spec, brainstorm, and break-loop skills in `templates/common/skills/`; `templates/trellis/scripts/` (`add_session.py`, `common/spec_match.py`, `common/spec_inject.py`); `templates/shared-hooks/inject-spec-context.py`; `templates/markdown/spec/`; `templates/trellis/workflow.md`; `templates/trellis/config.yaml` (`spec_injection`, `context_injection`).
- mini-trellis: the pi extension template, `mini-memory` guide, remember and update-spec, `docs/roadmap.md`, `README.md`.

## How to check

```bash
node scripts/check-upstream-trellis.mjs          # commits + diff stat per track, npm tags, new beta lines
node scripts/check-upstream-trellis.mjs --diff   # with the full diff of the watched paths
```

Or run `/trellis-lite-upstream` in this repository: the agent runs the script, reads the diffs, and drafts recommendations and decision-log rows. Clones are cached in `~/.cache/pi-preset/upstream/`; no remote is added to this repository.

Suggested rhythm: monthly, or after an upstream release. There is no scheduled job: every change needs a human decision, and an unread automatic report helps nobody.

## Evaluation rules

Adopt a change only if it does at least one of these:

- uses fewer tokens;
- improves the quality of what ends up in spec;
- fits pi better;
- fixes a behavior defect that trellis-lite has too.

Reject by default anything that adds standing injection, per-turn hooks, a state machine, or multi-host support.

When adopting: write the behavior in our own words (in the design doc or the commit message), implement it from that description, and do not copy code, comments, skill text, or template wording.

**Baselines move only after the user confirms**, and only once every upstream change up to the new baseline has a row below.

## Decision log

| Upstream change | Decision | Reason | pi-preset commit |
|---|---|---|---|
| Trellis beta: path-scoped spec injection (`spec_match.py`, `spec_inject.py`, `inject-spec-context.py`, `spec_injection` config) | Partly adopted | Same frontmatter `paths:` format and glob meaning. Injected into pi tool results instead of a hook. Once per session (again after compaction or a spec change), with no time-based reminder, and budgets of 6000/8000/40000 characters | `a0c397e` |
| Trellis beta: workflow variants (`.trellis/workflows/<id>.md`, four-level selection) | Not adopted | trellis-lite has no workflow document; project procedures live in `.pi/prompts/` or `AGENTS.md` | — |
| Trellis beta: `truncateUtf8` fix in the pi extension | Not applicable | Budgets count characters and truncate on UTF-16 boundaries (`src/trellis-lite/text.ts`) | — |
| Trellis main `36292d64`: skip the moved-away path when committing an archive | Not applicable | trellis-lite never commits; archiving is a `git mv` the user commits | — |
| mini-trellis: SessionStart orientation of paths only, ≤4000 characters | Adopted in spirit | `project-memory` section: paths and counts, ≤1500 characters, byte-stable per session | `cbb054a` |
| mini-trellis: `.trellis/research/` as a first-class directory | Partly adopted | Listed in the section when present; tasks are not converted into research topics | `cbb054a` |
| mini-trellis: `migrate` turns `tasks/` into `research/` | Not adopted | Existing `.trellis/` data must keep working unchanged | — |
| mini-trellis: `mem` search across hosts' chat logs | Not adopted | The journal is the memory; pi session logs can be grepped directly | — |
