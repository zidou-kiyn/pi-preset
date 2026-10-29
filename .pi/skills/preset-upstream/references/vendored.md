# Vendored packages and termius-mcp

Records: `vendor/UPSTREAM.json` (repo, track, recorded commit, `localChanges`). Licenses are MIT / BSD: code may be taken.

## Check

- `npm run upstream -- status`. An `ERROR` line usually means a wrong `track` (renamed default branch, tag-only release): check `git ls-remote <repo>` and fix the record.
- Read every new commit: `npm run upstream -- diff <name>`, or `git -C ~/.cache/pi-preset-upstream/<clone> show <sha>`.

## Carry over

Choose the method per package:

- **Most changes taken:** `npm run upstream -- pull <name> --to <rev>` (moves the recorded commit). Then:
  - read every merged file, not just the conflicts;
  - resolve conflicts so every `localChanges` entry still holds;
  - revert anything the user skipped.
- **Otherwise:** port the chosen changes by hand, then set `commit` and `version` to the revision reviewed up to.

Then update `localChanges`:

- drop entries upstream now covers;
- reword entries that changed;
- add `Not taken from upstream <sha>: <what> (<why>)` for each skipped change, so `npm run upstream -- check` does not show it as an unexplained difference.

Update the vendored-package table in `docs/extensions.md`.

## Verify

`npm run upstream -- check` shows no unexplained difference for the package.
