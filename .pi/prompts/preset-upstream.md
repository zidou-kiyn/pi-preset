---
description: Review upstream changes to everything this preset maintains (extensions, MCP, skills, trellis-lite) and decide what to carry over
argument-hint: "[package... | mcp | skills | trellis]"
---
Review what changed upstream and help me decide what to carry over. Scope: ${@:-everything}. Answer in the language I write to you in.

Everything here is our own maintained copy, often with local changes; nothing follows upstream automatically. Work one upstream change at a time: understand it, judge it against our copy, then take it, take it adapted, or skip it.

Start from a clean working tree (`git status`); if it is dirty, stop and ask.

## 1. Check (read-only)

- **Vendored packages and termius-mcp.** Records are in `vendor/UPSTREAM.json` (repo, track, recorded commit, `localChanges`). Code may be taken (MIT / BSD).
  - Run `npm run upstream -- status`. An `ERROR` line usually means a wrong `track` (renamed default branch, tag-only release): check `git ls-remote <repo>` and fix it.
  - Read every new commit: `npm run upstream -- diff <name>`, or `git -C ~/.cache/pi-preset-upstream/<clone> show <sha>`.
- **chrome-devtools-mcp.** Only a version pin: `CHROME_DEVTOOLS_MCP_VERSION` in `src/manifest.ts`.
  - Compare it with `npm view chrome-devtools-mcp version`.
  - If newer, read the changelog for breaking changes, the flags and env we set, telemetry defaults, and Node requirements.
- **Skills `grill-me` / `grilling`.** Record in `skills/NOTICE.md`; ported by hand (MIT).
  - Clone or fetch a blobless bare clone at `~/.cache/pi-preset-upstream/github.com_mattpocock_skills`.
  - Run `git diff <NOTICE commit>..HEAD -- skills/productivity/grill-me skills/productivity/grilling`.
- **trellis-lite.** Clean room: upstream is AGPL, so read for behavior only. Rules and decision log are in `docs/trellis-lite-upstream.md`.
  - Run `node scripts/check-upstream-trellis.mjs` (`--diff` for the watched paths).

## 2. Judge, report, ask

For each upstream change, say in your own words what it does. Then answer:

- Which `localChanges` entry does it meet, if any? Does upstream now cover it, conflict with it, or leave it alone?
- Does our copy have the defect it fixes?
- Is it released? Unreleased work on a non-default branch is "wait", unless it fixes something we hit.
- Is it security-relevant (secrets, host keys, redaction, network, permissions)? Say so explicitly.
- For trellis-lite: how does it fare under the evaluation rules?

Report one table per kind with changes: change | what it does | meets local change | **take / take adapted (how) / skip (why) / wait**. Put the kinds without changes on one line.

Then ask me with `ask_user_question` (multi-select, recommended first). Change nothing before I answer.

## 3. Carry over what I chose

**Vendored packages.** Choose the method per package:

- Most changes taken: `npm run upstream -- pull <name> --to <rev>`, which moves the recorded commit. Then:
  - read every merged file, not just the conflicts;
  - resolve the conflicts so every `localChanges` entry still holds;
  - revert anything I skipped.
- Otherwise: port the chosen changes by hand, then set `commit` and `version` to the revision you reviewed up to.

Then update `localChanges`:

- drop entries upstream now covers;
- reword entries that changed;
- add `Not taken from upstream <sha>: <what> (<why>)` for each skipped change, so `npm run upstream -- check` does not show it as an unexplained difference.

Update the README Extensions table too.

**chrome-devtools-mcp.** Bump the constant and both versions in `README.md`. Adjust args or env if the changelog requires it.

**Skills.** Port the chosen changes by hand, keeping the adaptations listed in `skills/NOTICE.md`. Update its commit, date, and change list.

**trellis-lite.**

- No upstream code, comments, skill text, or template wording, not even closely paraphrased, not even in a draft.
- Describe each adopted behavior in our own words (decision-log row, plus `docs/trellis-lite-design.md` when the design changes), and implement it from that description.
- Add a log row for every reviewed change, with the commit column empty.
- Aim for the best result, not for compatibility. If that means a new on-disk format, follow design §8.1: no legacy readers; an `upgrade` step and version bump in the same change, tested on old fixtures.
- Never move a baseline in `trellis-lite/upstream.json` without my confirmation.

**Verify.**

- Run `npm test`, plus `npm run test:termius` if termius-mcp changed.
- Run `grep -rn '^<<<<<<<\|^>>>>>>>' vendor skills` and expect no matches.

## 4. Finish

Summarize what was taken, adapted, skipped, or deferred, with the test results.

Propose commit messages, one per unrelated component (`chore(upstream): ...`, `feat(trellis-lite): ...`). Do not commit, push, tag, move a baseline, or release unless I say so.
