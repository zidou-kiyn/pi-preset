# Development

```bash
npm install                 # vendored packages' dependencies (pi's own packages come from the host)
npm test                    # preset tests + the vendored patty suite
npm run test:termius        # the vendored termius-mcp suite (needs uv)
./scripts/scan-secrets.sh   # working tree + full history
node scripts/check-upstream-trellis.mjs   # Trellis / mini-trellis changes since trellis-lite's baselines
```

Try a local checkout in a throwaway agent dir before pushing (copy `models.json` and `auth.json` in if the run needs a model):

```bash
export PI_CODING_AGENT_DIR=$(mktemp -d)
echo '{"packages":["'$PWD'"]}' > $PI_CODING_AGENT_DIR/settings.json
pi
```

## Versions

Releases are git tags `vX.Y.Z` with the same version in `package.json`; trellis-lite and the vendored extensions have no versions of their own and follow the preset's. The installed `packages[]` entry still follows the default branch (see [Git ref semantics](setup.md#git-ref-semantics)), so tags are for comparing machines, not for pinning. `/pi-preset` shows the installed version and commit in its title, e.g. `pi-preset 0.3.0 (abc1234)`.

```bash
npm run release -- minor    # or patch / major / X.Y.Z; needs a clean tree, runs npm test, commits "release: vX.Y.Z", tags it
git push --follow-tags
```

The tag message lists the commits since the previous tag.

## Following upstream

```bash
npm run upstream -- status                 # upstream commits since each vendored commit
npm run upstream -- diff pi-patty-bg-tasks # the upstream diff for one package
npm run upstream -- pull pi-patty-bg-tasks # three-way merge it into vendor/ (--to REV for a specific tag/commit)
npm run upstream -- check                  # what differs locally from the recorded upstream commit
```

`pull` merges file by file with `git merge-file`: files changed only upstream are replaced, files changed on both sides get conflict markers, and the recorded commit moves. It never commits; review with `git diff`, run `npm test`, and update `localChanges` in `UPSTREAM.json` when a local change is dropped or added. Upstream clones are cached in `~/.cache/pi-preset-upstream`.

The vendored packages are maintained copies, not mirrors. Upstream changes are reviewed one by one and taken, adapted, or skipped. A skipped change is recorded as `Not taken from upstream …` in `localChanges`. `pull` is one way to carry changes over; porting the chosen ones by hand is the other.

In this repository, `/preset-upstream [package... | mcp | skills | trellis]` ([`.pi/prompts/preset-upstream.md`](../.pi/prompts/preset-upstream.md)) has the agent do the whole round for everything the preset maintains: vendored packages, the pinned chrome-devtools-mcp, the skills, and trellis-lite's clean-room references. It judges each upstream change against our local changes, asks what to carry over, then applies, records, and tests it. It never commits.

## Design notes

- **Vendored, not depended on.** Every extension is a reviewed copy in this repository, so an upstream release cannot change behavior until it is pulled, local fixes need no fork per package, and updating the one package updates everything. The cost is following upstream by hand; `npm run upstream -- status` shows what is pending.
- **Few personal preferences are shipped.** The sync flow sets only the fullscreen TUI keys and the chrome-devtools MCP server besides `packages[]`. `defaultProvider` and `defaultModel` are written only when you apply the models.json template, and you pick them there. No `theme`, no `defaultThinkingLevel`, no `AGENTS.md`.
- **No credentials, ever.** The models template holds only placeholder endpoints and `$ENV_VAR` keys. `scripts/scan-secrets.sh` scans the working tree and the full git history before every push. Personal identifiers to block (user name, relay hosts, local ports) are kept out of the repository too: put one regular expression per line in `~/.config/pi-preset/scan-private-patterns` (or point `PI_PRESET_SCAN_PRIVATE` at a file). Reviewed false positives in vendored code are allowlisted by line hash in `scripts/scan-secrets-allow.json`.
- **`packages[]` changes need a restart.** Extensions get no access to pi's settings manager, so the sync writes the file while the running session still holds the array it loaded at startup. If you use `/config` or `pi install` in that same session afterwards, pi persists its stale snapshot and removed entries come back. Re-running the sync fixes it; nothing else is lost.
- **MCP goes through codemode.** The preset adds two servers, chrome-devtools (in `mcp.json`) and Termius (registered by its extension), both with codemode exposure, so their tools are called from scripts instead of being declared. Other servers carry credentials and differ per person, so they are left to `/mcp`. The footer shows what is connected.
- **Runtime dependencies are the vendored packages' own:** `@ff-labs/fff-node` / `fff-bun` (fff's native search library), `ignore` (workspace-history), `diff` (apply-patch), and the vendored `rpiv-config` through a `file:` dependency. pi installs them with the package. The Termius server's Python dependencies (paramiko, pynacl, cryptography, keyring, …) live in its own environment, created by `/termius setup`.
- **trellis-lite is written here, not vendored.** Trellis and mini-trellis are AGPL-3.0; this repository is MIT. trellis-lite is a clean-room implementation: upstream is read for behavior and file formats only, changes are described in our own words in the design doc or decision log, then implemented. Its skills are not in `package.json` `pi.skills`, because a package skill is visible in every project; the extension offers them per project.
- **`pi-startup-redraw-fix` is not included.** It rewrites `ESC[3J ESC[2J ESC[H` into `ESC[H ESC[2J ESC[3J`, but pi's alternate-screen renderer emits `ESC[2J ESC[H ESC[3J`, which never matches its trigger. The patch cannot fire.

## Repository layout

| Resource | Effect |
|---|---|
| `extensions/vibrant-footer.ts` | The status bar. Toggle with `/vibrant-footer` |
| `extensions/pi-preset.ts` | The `/pi-preset` control panel: sync state on top; sync, the models.json template, and the font-install prompt. The menu itself is `src/preset-menu.ts`, shared with `/termius` and `/trellis-lite` |
| `extensions/compact-tools.ts` | Caps collapsed `edit` rows (see [Tool rows](extensions.md#tool-rows-extensionscompact-toolsts)). No command |
| `extensions/termius.ts` | Installs and registers the Termius MCP server, `/termius`, approval modes, and the local guard (see [SSH](mcp.md#ssh-the-termius-mcp-server)) |
| `extensions/cache-retention.ts` | Defaults `PI_CACHE_RETENTION` to `long` inside pi (1h Anthropic cache TTL, 24h OpenAI Responses retention) so it applies even in shells that never sourced your rc file. An explicit value in the environment wins. No command, no UI |
| `extensions/idle-keepwarm.ts` | Keeps the Anthropic prompt cache warm while pi's UI stays open and idle, past pi's own 30-minute idle limit (see below). Status bar segment `keepwarm`, no command |
| `extensions/trellis-lite.ts` | Project memory for `.trellis/` projects: spec, journal, light task plans (see [trellis-lite](trellis-lite.md)). `/trellis-lite`, `/trellis-lite-migrate` |
| `extensions/todo-nudge.ts` | A one-line reminder in a tool result when a todo task stays in_progress too long, and a note when a second task is started on top (see [Todo nudges](extensions.md#todo-nudges-extensionstodo-nudgets)). No command |
| `extensions/inherit-model.ts` | `/new` keeps the model and thinking level you were just using instead of falling back to `defaultModel` (see below). No command, no UI |
| `vendor/` | The vendored extensions (see [Extensions](extensions.md)) |
| `skills/` | `grill-me`, `grilling`, and `handoff` (see [Skills](../README.md#skills)) |
| `trellis-lite/` | trellis-lite's skills (loaded only in Trellis projects), its CLI, the migration prompt, and upstream baselines |
| `templates/models.json`, `templates/settings.json` | The provider template (placeholder endpoints and keys) and its default provider/model |
| `scripts/upstream.mjs`, `scripts/migrate-vendored.ts` | Upstream tracking and the 0.1 → 0.2 migration |
| `scripts/release.mjs` | `npm run release`: version bump, commit, and tag (see [Versions](#versions)) |
| `scripts/check-upstream-trellis.mjs` | What changed in Trellis and mini-trellis since trellis-lite's baselines (read-only) |
