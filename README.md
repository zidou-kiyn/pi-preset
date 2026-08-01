# pi-preset

Personal [pi](https://pi.dev) environment as a pi package: a theme-reactive status bar, a curated extension set, the handful of non-default config keys, and the Nerd Font the footer's glyphs need.

Reproduces the base working setup on a new machine in two commands, without shipping a single credential; the optional upstream grilling workflow has its own explicit sync command.

## Bootstrap

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi, then run:

```
/preset-sync
```

`/preset-sync` shows a diff of everything it would change and writes nothing until you confirm. Restart pi once more so the newly declared packages install and load — and do that before touching `/config` in the same session (see [Design notes](#design-notes)). If you want the optional upstream grilling workflow, run `/preset-skills-sync` to install its two required skills.

To add a custom model provider, run `/preset-models-add` in interactive TUI mode. The wizard writes only the selected provider entry to `~/.pi/agent/models.json` and never changes `/preset-sync` behavior.

## Interactive model provider wizard

`/preset-models-add` is a deterministic, TUI-only wizard for three fixed model bundles:

| Family | Models | Fixed API mode |
|---|---|---|
| Anthropic | Claude Fable 5, Claude Opus 5, Claude Sonnet 5 | `anthropic-messages` |
| OpenAI | GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna | `openai-responses` |
| DeepSeek | DeepSeek V4 Flash | `openai-responses` |

Choose a family, explicitly select one or more models, then enter a provider identifier, base URL, and API key. The catalog metadata, compatibility flags, thinking-level maps, context limits, modalities, and pricing tiers are bundled in the package; the wizard never asks for those schema details. The API key is collected by a masked TUI component and is not rendered in the preview, notifications, diagnostics, or command arguments. RPC, JSON, and print modes report that the wizard requires interactive TUI mode and do not write anything.

The target file is parsed with Pi-compatible `//` comments and trailing commas. Only `providers[providerId]` is added or replaced; unrelated top-level data and sibling providers are re-read immediately before the atomic write and preserved. Existing files must grant no group or other permissions. A missing file is created as `0600`; an existing owner-only mode such as `0600` or `0400` is preserved. A broader mode stops the wizard before API-key entry and prints an actionable `chmod 600` instruction. Valid symlinks are followed without replacing the symlink inode; dangling symlinks are blocked.

The wizard shows a redacted provider-only diff and asks for explicit confirmation. Replacing a different existing provider requires a second confirmation and replaces that provider object as a unit rather than merging stale model fields. An existing identical provider is reported as already configured and does not create a backup or change the file mtime. Successful writes create `<real-models-path>.preset-bak` containing the original bytes, then atomically rename the new JSON. Open `/model` after success to hot-reload the selected models; no Pi restart is required.

Custom model entry and editing, arbitrary model metadata, OAuth, environment-variable generation, secret managers, and provider families outside Anthropic, OpenAI, and DeepSeek are intentionally out of scope. Use the provider's own endpoint and credentials locally; the public preset contains no user-specific provider identifier, endpoint, or credential.

## Upstream grilling skills

The preset can install Matt Pocock's upstream [`skills`](https://github.com/mattpocock/skills) workflow. The repository and its skill content are MIT-licensed; Matt Pocock owns the upstream files. This package does not vendor, rewrite, or behaviorally fork them. It invokes the official Vercel `skills` CLI at install or refresh time instead.

Both skills are required:

- `grill-me` is the explicitly invoked wrapper. Use `/skill:grill-me` to start a session.
- `grilling` is the separate interview primitive. Use `/skill:grilling` to invoke it directly.

Pi does not infer a transitive skill dependency, so installing only `grill-me` is not sufficient. The preset's dedicated `/preset-skills-sync` command installs or refreshes both names together. It is the only preset command that performs this network/npm work; `/preset-sync` never installs or refreshes upstream skills.

### Install, refresh, or repair

Run `/preset-skills-sync` in TUI or RPC mode. It shows a read-only plan, asks for explicit confirmation, then invokes this fixed filtered command without a shell:

```bash
npx --yes skills@latest add mattpocock/skills \
  --skill grill-me --skill grilling \
  --agent pi --global --copy --yes
```

The same filtered `add` command is used for first installation, later refreshes, and repair. The preset deliberately does not use `skills update`: the current update path can drop `--agent pi` and `--copy`, which can retarget another agent or change a Pi-only copy into a different layout. If `npx` is unavailable, the command uses the no-shell equivalent:

```bash
npm exec --yes --package=skills@latest -- skills add mattpocock/skills \
  --skill grill-me --skill grilling \
  --agent pi --global --copy --yes
```

Node.js 22.20 or newer and npm are required. Network, npm, or GitHub failures are reported without changing the previous pair. The command snapshots the two target entries in both skill roots and the complete global lock before invoking the installer; a non-zero exit or invalid post-install state restores that snapshot and prints a safe recovery command. Concurrent preset-managed runs are serialized with a short-lived lock next to the global skill lock, and a stale lock from a dead process is recovered automatically. Installer diagnostics are control-sequence stripped, credential-redacted, and bounded before display.

Do not use `--all`, install the Claude plugin, install the whole Matt repository as a pi package, or copy individual files into the skill roots. Those paths can load unrelated skills or create duplicate names. If the command finds two independent copies of the same skill, it stops and reports the paths; it never deletes an intentional third-party copy automatically.

The official CLI invocations disable its optional telemetry and npm lifecycle scripts. The preset stores no credentials, passes no CLI metadata, and adds no provider configuration. The child inherits the user’s normal process environment so existing npm, GitHub, proxy, and CA configuration keeps working; displayed diagnostics redact common credential forms. In TUI and RPC modes, a successful content change reloads Pi resources before the command returns. A restart is a fallback if reload is unavailable. Print (`-p`) and JSON modes only render the plan to the appropriate diagnostic stream; they never ask for consent, invoke npm, or write files.

Installed state is kept in these global locations:

- Pi targets: `~/.pi/agent/skills/grill-me/` and `~/.pi/agent/skills/grilling/`
- Duplicate-check root: `~/.agents/skills/`
- Lock: `~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set

Skills execute as model instructions with Pi's agent permissions. Review the two upstream `SKILL.md` files before enabling them, just as you would review any extension or package with system access.

## What it ships

| Resource | Effect |
|---|---|
| `extensions/vibrant-footer.ts` | The status bar. Toggle with `/vibrant-footer` |
| `extensions/preset-sync.ts` | The `/preset-sync` command |
| `extensions/preset-skills-sync.ts` | The `/preset-skills-sync` upstream skill installer and refresher |
| `extensions/preset-models-add.ts` | The `/preset-models-add` masked model-provider wizard |

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
