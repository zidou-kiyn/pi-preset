---
description: Review what changed upstream of everything this preset maintains (extensions, MCP, skills, trellis-lite) and decide what to carry over
argument-hint: "[package... | mcp | skills | trellis]"
---
Review what changed upstream of the code this preset maintains and help me decide what to carry over. Scope: ${@:-everything}. Answer in the language I write to you in.

Nothing here follows upstream automatically. Every vendored package is our own maintained copy, and many carry local changes. The unit of work is one upstream change, not one package: understand it, judge it against our copy, then take it as is, take it adapted, or skip it. Upstream's code is input to that decision, never a replacement for our copy.

Read first: `vendor/UPSTREAM.json` (per package: repo, tracked branch/tags, recorded commit, `localChanges`), the "Following upstream" part of `README.md`, `skills/NOTICE.md`, and `docs/trellis-lite-upstream.md` (evaluation rules and decision log). Start from a clean working tree (`git status`); if it is dirty, stop and ask.

## The four kinds of upstream

| Kind | Where it is recorded | May code be taken? |
|---|---|---|
| Vendored extensions and termius-mcp (`vendor/`) | `vendor/UPSTREAM.json` | Yes (MIT / BSD), adapted to our copy |
| chrome-devtools-mcp (npm, not vendored) | `CHROME_DEVTOOLS_MCP_VERSION` in `src/manifest.ts` | Not applicable: we only pin a version |
| Skills `grill-me` / `grilling` | `skills/NOTICE.md` | Yes (MIT), ported by hand |
| trellis-lite (behavior from Trellis / mini-trellis) | `trellis-lite/upstream.json`, decision log in `docs/trellis-lite-upstream.md` | **No.** Clean room, because upstream is AGPL-3.0 |

## 1. Check (read-only)

1. **Vendored**: `npm run upstream -- status`. A line with `ERROR` usually means the `track` in `UPSTREAM.json` is wrong (renamed default branch, release made only as a tag): check `git ls-remote <repo>` and fix `track`. For each package with commits, read every commit: `npm run upstream -- diff <name>`, and `git -C ~/.cache/pi-preset-upstream/<clone> show <sha>` per commit.
2. **chrome-devtools-mcp**: compare the pinned version with `npm view chrome-devtools-mcp version`. If newer, read the changelog between the two versions (GitHub releases of ChromeDevTools/chrome-devtools-mcp). Look for breaking changes, renamed or removed flags or env we set in `src/manifest.ts`, new telemetry defaults, and new Node requirements.
3. **Skills**: use a blobless bare clone in `~/.cache/pi-preset-upstream/github.com_mattpocock_skills` (`git clone --bare --filter=blob:none`, or `git fetch` if it exists). Run `git log` and `git diff <commit in NOTICE.md>..HEAD -- skills/productivity/grill-me skills/productivity/grilling`.
4. **trellis-lite**: `node scripts/check-upstream-trellis.mjs` (`--diff` for the watched paths). Also note a new npm version or a new beta line.

## 2. Judge each upstream change

For every upstream commit or change, say in your own words what it does and what it would mean for our copy:

- Does it touch code we changed? Then name the `localChanges` entry it meets, and say whether upstream now covers that change, conflicts with it, or is independent of it.
- Does it fix a defect our copy also has? Check our copy, not just upstream's.
- Is it released? Treat unreleased work on a non-default branch as "wait" unless it fixes something we hit.
- Call out security-relevant changes explicitly (secrets, host keys, redaction, network, permissions).
- For trellis-lite, apply the evaluation rules in `docs/trellis-lite-upstream.md`, and point out where trellis-lite has the same defect when the change is a fix.

Recommend one of: **take**, **take adapted** (say how), **skip** (say why), or **wait**.

## 3. Report, then ask

Give one table per kind that has changes: upstream change | what it does | meets which local change | recommendation. List the kinds without changes in a single line. Then ask me through `ask_user_question` what to carry over (multi-select, recommended items first). Change nothing before I answer.

## 4. Carry over what I chose

**Vendored packages.** Pick the method per package:

- Most changes taken, few conflicts with our changes: `npm run upstream -- pull <name> --to <rev>`. It merges file by file and moves the recorded commit. Then read every merged file, not only the conflicts. Resolve each `<<<<<<<` so that every `localChanges` entry still holds, and revert any upstream change I chose to skip.
- Only some changes taken, or heavy conflicts: port the chosen changes by hand into our copy. Then set `commit` (and `version`) in `UPSTREAM.json` to the upstream revision you reviewed up to.

Either way, update `localChanges` in `UPSTREAM.json`:

- remove an entry that upstream now covers;
- reword an entry that changed;
- add `Not taken from upstream <sha>: <what> (<why>)` for every skipped change at or before the recorded commit. Otherwise `npm run upstream -- check` would show it as an unexplained local difference.

Update the version and "Local changes" column of the README Extensions table.

**chrome-devtools-mcp.** Bump `CHROME_DEVTOOLS_MCP_VERSION` and the version in `README.md` (two places). Adjust args or env if the changelog requires it.

**Skills.** Port the chosen changes by hand, keeping the local adaptations listed in `skills/NOTICE.md`. Update the commit, date, and change list there.

**trellis-lite: clean room.**

- Do not copy or closely paraphrase upstream code, comments, skill text, or templates into this repository, not even in a draft.
- Describe each adopted behavior in our own words (decision-log row, and `docs/trellis-lite-design.md` when the design changes), and implement it from that description.
- Add a decision-log row for every upstream change reviewed, with the commit column empty.
- Do not touch `trellis-lite/upstream.json`. Baselines move only after I confirm, and only once every change up to the new baseline has a row.

**Verify.** Run `npm test`, plus `npm run test:termius` when termius-mcp changed. Run `grep -rn '^<<<<<<<\|^>>>>>>>' vendor skills` to confirm no conflict markers are left.

## 5. Finish

Summarize what was taken, adapted, skipped, or deferred, with the test results. Propose commit messages, one per component when unrelated (`chore(upstream): ...`; trellis-lite behavior changes as `feat(trellis-lite): ...`). Do not commit, push, tag, move a trellis-lite baseline, or release unless I say so.
