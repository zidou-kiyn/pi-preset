# pi-preset

Personal [pi](https://pi.dev) environment as a pi package: a theme-reactive status bar, a curated extension set, the handful of non-default config keys, and the Nerd Font the footer's glyphs need.

Reproduces a working setup on a new machine in two commands, without shipping a single credential.

## Bootstrap

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi, then run:

```
/preset-sync
```

`/preset-sync` shows a diff of everything it would change and writes nothing until you confirm. Restart pi once more so the newly declared packages install and load — and do that before touching `/config` in the same session (see [Design notes](#design-notes)).

## What it ships

| Resource | Effect |
|---|---|
| `extensions/vibrant-footer.ts` | The status bar. Toggle with `/vibrant-footer` |
| `extensions/preset-sync.ts` | The `/preset-sync` command |

## What `/preset-sync` does

1. **Declares 13 extensions** in `~/.pi/agent/settings.json` `packages[]`.
2. **Sets 2 config keys** in `web-search.json` (see below).
3. **Moves a local `extensions/vibrant-footer/`** into `extensions-disabled/` if one exists, so the footer does not load twice.
4. **Installs the font** when it is missing.

Every step is idempotent. A second run reports "already in sync" and touches nothing — not even file mtimes.

### The 13 extensions

| Package | |
|---|---|
| `npm:pi-wtf` | `npm:pi-web-access` |
| `npm:pi-workspace-history` | `npm:@lll9p/pi-better-compaction` |
| `npm:@ff-labs/pi-fff` | `npm:pi-web-search` |
| `npm:pi-tool-display` | `git:github.com/code-yeongyu/pi-apply-patch` |
| `npm:@narumitw/pi-chrome-devtools` | `npm:@juicesharp/rpiv-todo` |
| `npm:pi-playwright` | `npm:@juicesharp/rpiv-ask-user-question` |
| `npm:@amaster.ai/pi-image-gen` | |

They are declared as **independent `packages[]` entries**, not bundled inside this package. That is deliberate: `pi update --extensions` only iterates sources listed in `settings.json`, so bundling them would freeze their versions forever. As independent entries, each one keeps its native update behavior.

`@amaster.ai/pi-image-gen` needs its own provider credentials. Configure them locally; this package never ships keys.

### The 2 config keys

Written to `web-search.json`:

```json
{
  "webSearch": { "enabled": false },
  "ssrf": { "trustEnvProxy": true }
}
```

Nothing else is written. Both consumers fall back per key to their own defaults, so a partial file is valid and no upstream default can be frozen by a stale snapshot.

**That file also holds every provider API key.** Writes are therefore a deep merge of exactly those two leaf keys — never a whole-file overwrite. If the file does not parse as JSON, the step aborts rather than starting from `{}` and erasing your keys. The previous content is copied to `<file>.preset-bak` before every write, and the write itself is a tmp-file rename so an interrupted run cannot truncate it.

`settings.json` `packages[]` is **append-only**: entries are deduplicated by pi's own identity rule (npm compares the package name, git compares the repository URL without its ref), and packages you added yourself are never reordered or removed.

## Font

The footer uses Nerd Fonts v3 Material Design glyphs (`nf-md-*`). Without a Nerd Font they render as tofu.

`/preset-sync` detects the family **`Maple Mono NF CN`** and skips when present. Detection is a purely local check — `fc-list` where available, otherwise a scan of the platform font directories — so a machine that already has the font issues no network request and keeps whatever build it has.

When the font is missing:

| Platform | Behavior |
|---|---|
| Linux | Downloads the `NF-CN-unhinted` asset from the **latest** release into `$XDG_DATA_HOME/fonts/maple-nf-cn/`, then runs `fc-cache -f` |
| macOS | Same, into `~/Library/Fonts/` |
| Windows | **Writes nothing.** Prints the release link and manual steps |

No version is pinned anywhere. The asset is resolved from whatever GitHub currently reports as the latest release, and matched by pattern rather than filename, because filenames are not stable across releases.

Extraction shells out to `unzip`, falling back to `bsdtar` then `tar`. Note that GNU `tar` cannot read zip archives, so on Linux you need `unzip` or `bsdtar` installed.

> **You must set your terminal font to `Maple Mono NF CN` yourself.** Installing the font does not change your terminal emulator's configuration, and nothing in this package can.

## Git ref semantics

The `packages[]` entry for this package deliberately carries **no `@ref`**:

```
git:github.com/zidou-kiyn/pi-preset
```

pi only reconciles a git source to its *configured* ref and never advances it on its own. Omitting the ref means the clone follows the default branch, so `pi update --extensions` picks up new commits. Pinning a tag here would mean every change required editing `settings.json` on every machine.

## Design notes

- **No preferences are shipped.** No `theme`, no `defaultProvider`, no `defaultModel`, no `defaultThinkingLevel`, no `AGENTS.md`. Those are personal and belong on the machine, not in a package.
- **No credentials, ever.** `scripts/scan-secrets.sh` scans the working tree and the full git history before every push.
- **No automatic `pi install`.** `/preset-sync` only writes `packages[]` and lets pi install on its next start.

  > **Restart pi after a sync that changed `packages[]`.** Extensions get no access to pi's settings manager, so the write goes straight to the file while the running session still holds the array it loaded at startup. If you use `/config` or `pi install` in that same session afterwards, pi persists its stale snapshot and the newly added entries disappear. Re-running `/preset-sync` restores them; nothing else is lost.
- **No runtime dependencies.** Zip extraction uses system tools instead of adding a supply-chain layer.
- **`pi-startup-redraw-fix` is not included.** It rewrites `ESC[3J ESC[2J ESC[H` into `ESC[H ESC[2J ESC[3J`, but pi's alternate-screen renderer emits `ESC[2J ESC[H ESC[3J`, which never matches its trigger. The patch cannot fire.

## Development

```bash
./scripts/scan-secrets.sh   # working tree + full history
```

Install from a local checkout to test before pushing:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi install ~/pi-preset
```

## License

MIT
