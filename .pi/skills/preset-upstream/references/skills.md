# Store skills

Two groups:

- **Ported by hand (MIT):** `grill-me`, `handoff`, `codebase-design`, `diagnosing-bugs`, and `skill-authoring/references/writing-for-agents.md`. Record (upstream commit per skill, date, adaptations, change list) in `skills-store/pi-preset/NOTICE.md`.
- **Vendored:** the `skill-*` entries in `vendor/UPSTREAM.json`, under `skills-store/humanizer/` and `skills-store/anthropics/`. Handle them exactly like vendored packages: `references/vendored.md`.

## Check (ported skills)

- Clone, or fetch, a blobless bare clone at `~/.cache/pi-preset-upstream/github.com_mattpocock_skills`.
- Per row of the NOTICE table: `git diff <its commit>..HEAD -- <its upstream paths>`

## Carry over (ported skills)

- Port the chosen changes by hand, keeping the adaptations listed in `NOTICE.md`.
- Update its commit, date, and change list; note skipped changes with the reason.
