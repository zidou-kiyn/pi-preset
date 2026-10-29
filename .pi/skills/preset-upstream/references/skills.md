# Store skills

Two groups:

- **Ported by hand (MIT):** `grill-me`, `handoff`. Record (upstream commit, date, adaptations, change list) in `skills-store/pi-preset/NOTICE.md`.
- **Vendored:** the `skill-*` entries in `vendor/UPSTREAM.json`, under `skills-store/humanizer/` and `skills-store/anthropics/`. Handle them exactly like vendored packages: `references/vendored.md`.

## Check (ported skills)

- Clone, or fetch, a blobless bare clone at `~/.cache/pi-preset-upstream/github.com_mattpocock_skills`.
- `git diff <NOTICE commit>..HEAD -- skills/productivity/grill-me skills/productivity/grilling skills/productivity/handoff`

## Carry over (ported skills)

- Port the chosen changes by hand, keeping the adaptations listed in `NOTICE.md`.
- Update its commit, date, and change list; note skipped changes with the reason.
