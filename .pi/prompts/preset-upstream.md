---
description: Check the upstreams of vendored extensions, MCP servers, and skills; report and follow what is worth taking
argument-hint: "[package...]"
---
Check every upstream this preset follows, report what changed, and bring the local copies up to date where it is worth it. Scope: ${@:-everything}. Answer in the language I write to you in.

Read first: `vendor/UPSTREAM.json` (repo, tracked branch/tags, recorded commit, `localChanges` for each vendored package), the "Following upstream" part of `README.md`, and `skills/NOTICE.md`. Start from a clean working tree (`git status`); if it is dirty, stop and ask.

## 1. Check (read-only)

1. **Vendored extensions and termius-mcp**: `npm run upstream -- status`. A line with `ERROR` usually means the `track` in `UPSTREAM.json` is wrong (renamed default branch, release made only as a tag): check `git ls-remote <repo>` and fix `track`. For every package with commits: `npm run upstream -- diff <name>` and the commit messages.
2. **chrome-devtools-mcp**: compare `CHROME_DEVTOOLS_MCP_VERSION` in `src/manifest.ts` with `npm view chrome-devtools-mcp version`. If newer, read the changelog between the two versions (GitHub releases of ChromeDevTools/chrome-devtools-mcp). Look for breaking changes, renamed or removed flags we pass (`--no-usage-statistics`, `--no-performance-crux`, the env vars in `src/manifest.ts`), new telemetry defaults, and new Node requirements.
3. **Skills** (`grill-me`, `grilling`, adapted from mattpocock/skills, maintained by hand): use a blobless bare clone in `~/.cache/pi-preset-upstream/github.com_mattpocock_skills` (clone with `git clone --bare --filter=blob:none`, or `git fetch` if it already exists). Run `git log` and `git diff <commit in NOTICE.md>..HEAD -- skills/productivity/grill-me skills/productivity/grilling`.
4. **trellis-lite** (clean room, not vendored): only run `node scripts/check-upstream-trellis.mjs` and say whether anything is pending. Its review is `/trellis-lite-upstream`; do not do it here.

## 2. Report, then ask

Give one table: component | local version/commit | upstream | what changed (own words, one line) | conflicts with our `localChanges`? | recommendation (take / take partly / skip / wait). Recommend "wait" for unreleased work on a non-default branch unless it fixes something we hit. Point out security-relevant changes (secrets, host keys, redaction, network) explicitly.

Then ask me through `ask_user_question` which items to apply (multi-select, recommended ones first). Change nothing before I answer.

## 3. Apply what I chose

- **Vendored package**: `npm run upstream -- pull <name>` (`--to <tag>` when needed). Resolve every `<<<<<<<` conflict so that each entry in its `localChanges` still holds; when an upstream change makes a local change unnecessary, drop it and say so. Update `version` and `localChanges` in `UPSTREAM.json`, and the version or "Local changes" column in the README Extensions table.
- **chrome-devtools-mcp**: bump `CHROME_DEVTOOLS_MCP_VERSION` and the version in `README.md` (two places); adjust args or env if the changelog requires it.
- **Skills**: port the upstream changes by hand while keeping the local adaptations listed in `skills/NOTICE.md`. Then update the commit and date in `NOTICE.md`.
- Verify with `npm test`, and `npm run test:termius` when termius-mcp changed. Run `grep -rn '^<<<<<<<\|^>>>>>>>' vendor skills` to confirm no conflict markers are left.

## 4. Finish

Summarize what changed, what was skipped and why, and the test results. Propose a commit message (`chore(upstream): ...`, one commit per component if they are unrelated). Do not commit, tag, or release unless I say so.
