# pi-preset

Personal [pi](https://pi.dev) environment as a pi package: a theme-reactive status bar, a curated extension set, the two non-default config keys (the ones that keep the background-task and tool-display extensions from fighting over `bash`), and the Nerd Font the footer's glyphs need.

Reproduces the base working setup on a new machine in two commands, without shipping a single credential; the optional upstream grilling workflow has its own explicit sync command.

## Bootstrap

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi, then run:

```
/pi-preset
```

`/pi-preset` is the preset's single visual control panel — a TUI menu with three entries:

1. **Sync preset** — packages, config keys, footer, and font. Starts with an optional-extension checklist (Chrome DevTools, unchecked by default), then shows a diff of everything it would change and writes nothing until you confirm.
2. **Install / refresh grilling skills** — the optional upstream grilling workflow.
3. **Add model provider** — the masked model-provider wizard for `~/.pi/agent/models.json`.

After a sync that added packages, restart pi so they install and load — and do that before touching `/config` in the same session (see [Design notes](#design-notes)).

## Optional extensions

`@narumitw/pi-chrome-devtools` is **not installed by default**: it drives a real browser, which not every machine wants. The sync flow opens with a checklist where you tick the ones this machine should have. Already-installed entries render checked and locked — the preset is additive-only and never removes a package, so unchecking an installed entry is not offered.

`pi-playwright` used to sit next to it and was dropped: Chrome DevTools already covers navigate / evaluate / screenshot against a live browser without Playwright's own browser downloads.

## Interactive model provider wizard

The **Add model provider** menu entry is a deterministic, TUI-only wizard for three fixed model bundles plus a fully custom channel:

| Family | Models | Fixed API mode |
|---|---|---|
| Anthropic | Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5 | `anthropic-messages` |
| OpenAI | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | `openai-responses` |
| DeepSeek | DeepSeek V4.1 Flash | `openai-responses` |
| Custom | user-defined | `openai-completions`, `openai-responses`, or `anthropic-messages` |

Choose a family, explicitly select one or more models, then enter a provider identifier, base URL, and API key. For the three preset families, the catalog metadata, compatibility flags, thinking-level maps, context limits, modalities, and pricing tiers are bundled in the package; the wizard never asks for those schema details.

The bundles target subscription relays (a ChatGPT or Claude subscription exposed as an API by a relay), so their parameters follow the subscription catalogs rather than the pay-as-you-go API ones:

- **OpenAI** thinking levels use the ChatGPT-subscription (`openai-codex`) mapping: `minimal` is served as `low`. GPT-6 Astra and GPT-6.1 Sol cannot disable reasoning, so `off` is unavailable for them. Context stays at the subscription's 272k.
- **Compatibility flags** mirror what pi's bundled catalog enables for these models and were verified end to end through two different subscription relays:
  - OpenAI: `supportsOpenAIGrammarTools` (grammar-constrained tools go out as native OpenAI custom tools) and `supportsMidConvoSystemMessages` (mid-conversation developer messages stay in place instead of being folded into the leading system prompt, which would break the cached prefix).
  - Anthropic: `supportsMidConvoEffort` (changing the thinking level mid-session keeps the prompt cache and binds thinking blocks), `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, and `supportsEagerToolInputStreaming`.

  `supportsAdditionalTools` and `supportsToolSearch` are left off: they only matter for MCP tools loaded through `tool_search` and have not been verified through a relay yet. If your relay rejects one of the enabled flags, add the provider through the **Custom** channel instead, where every one of these flags can be set to `false`.

The **Custom** entry is a generic channel for any OpenAI- or Anthropic-compatible endpoint (one-api/new-api relays, OpenRouter, vLLM, Ollama, Claude proxies, ...). Every step explains its options on screen before you choose:

1. **API protocol** — a described selector for `openai-completions` (chat completions, the most widely supported), `openai-responses`, or `anthropic-messages`.
2. **Compatibility flags** — a tri-state checklist filtered to the chosen protocol. Each flag shows what it does; Enter cycles *default → true → false*, where *default* omits the flag so Pi keeps its built-in or URL-auto-detected behavior.
3. **Models** — one or more models, each with model ID, display name, input modalities (text or text+image), thinking levels (none, OpenAI-, Anthropic-, or DeepSeek-style presets, each explained, or **Custom mapping**, which asks for the provider value of each of Pi's seven thinking levels — leave a level empty to make it unavailable), context window and max output tokens (accepts `128000`, `128k`, `1m`; empty picks a sensible default), and optional per-million-token costs entered as `input,output,cacheRead,cacheWrite`. Invalid entries re-prompt instead of aborting the wizard.

After that, the custom flow joins the normal path: provider identifier, base URL, masked API key, redacted diff preview, and atomic write. The API key is collected by a masked TUI component and is not rendered in the preview, notifications, diagnostics, or command arguments. RPC, JSON, and print modes report that the wizard requires interactive TUI mode and do not write anything.

The target file is parsed with Pi-compatible `//` comments and trailing commas. Only `providers[providerId]` is added or replaced; unrelated top-level data and sibling providers are re-read immediately before the atomic write and preserved. On POSIX filesystems, existing files must grant no group or other permissions. A missing POSIX file is created as `0600`; an existing owner-only mode such as `0600` or `0400` is preserved. On Windows, access is governed by ACLs; Node's numeric mode is only a writable/read-only approximation, so the wizard does not interpret synthetic group/other bits as POSIX permissions. On POSIX, a broader mode stops the wizard before API-key entry and prints an actionable `chmod 600` instruction. Valid symlinks are followed without replacing the symlink inode; dangling symlinks are blocked.

The wizard shows a redacted provider-only diff and asks for explicit confirmation. Replacing a different existing provider requires a second confirmation and replaces that provider object as a unit rather than merging stale model fields. An existing identical provider is reported as already configured and does not create a backup or change the file mtime. Successful writes create `<real-models-path>.preset-bak` containing the original bytes, then atomically rename the new JSON. Open `/model` after success to hot-reload the selected models; no Pi restart is required.

OAuth, environment-variable generation, secret managers, editing existing providers in place, and API protocols beyond the three listed above are intentionally out of scope. Advanced compat fields (e.g. `thinkingFormat`, routing preferences) can still be added by editing `models.json` by hand after the wizard writes the provider. Use the provider's own endpoint and credentials locally; the public preset contains no user-specific provider identifier, endpoint, or credential.

## Upstream grilling skills

The preset can install Matt Pocock's upstream [`skills`](https://github.com/mattpocock/skills) workflow. The repository and its skill content are MIT-licensed; Matt Pocock owns the upstream files. This package does not vendor, rewrite, or behaviorally fork them. It invokes the official Vercel `skills` CLI at install or refresh time instead.

Both skills are required:

- `grill-me` is the explicitly invoked wrapper. Use `/skill:grill-me` to start a session.
- `grilling` is the separate interview primitive. Use `/skill:grilling` to invoke it directly.

Pi does not infer a transitive skill dependency, so installing only `grill-me` is not sufficient. The preset's **Install / refresh grilling skills** menu entry installs or refreshes both names together. It is the only preset flow that performs this network/npm work; the sync flow never installs or refreshes upstream skills.

### Install, refresh, or repair

Choose **Install / refresh grilling skills** from `/pi-preset` in TUI or RPC mode. It shows a read-only plan, asks for explicit confirmation, then invokes this fixed filtered command without a shell:

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
| `extensions/pi-preset.ts` | The `/pi-preset` control panel: sync, skills, and model wizard in one TUI menu |
| `extensions/headless-keepalive.ts` | Keeps headless `pi -p` children alive during tool calls (works around a `pi-patty-bg-tasks` bug, see below). No command, no UI |
| `extensions/inherit-model.ts` | `/new` keeps the model and thinking level you were just using instead of falling back to `defaultModel` (see below). No command, no UI |

### Reading the status bar

```
✧ ~/project · ⎇ main
▰▱▱▱▱▱ 58k/272k 21% · ↑ in 48k ↓ out 38k · ▤ cache r 1.1M ↻ w 90k ◎ hit 93% · ◈ $0.410      provider · π model · ◆ high
⬡ pkg 12 · ⧉ mcp 2·14 cm ts · ☑ 1/3 · ▸ current task
```

- **Context**: the meter plus `used/window percent` of the current context. Its color turns warning above 70% and error above 90%.
- **in / out**: input and output tokens summed over the whole session, not the current context.
- **cache r / w / hit**: session totals of cache-read and cache-write tokens, and the latest turn's cache hit rate.
- **◈**: session cost as `$0.410` (`sub` when the model runs on an OAuth subscription), or `Σ` total tokens when the provider reports no price.
- **mcp servers·tools**: MCP servers connected through pi's built-in MCP support and their callable tools. Servers that failed or need a sign-in are not counted; pi reports them after startup and in `/mcp`. A dim `mcp 0` means MCP support is loaded but no server is connected. `cm` / `ts` mark the built-in `codemode` / `tool_search` tools while they are active. The segment is hidden only when the built-in MCP extension is disabled.

Word labels are shown whenever the stats fit in two lines, and dropped otherwise; the icons stay.

### `/new` inherits the current model

pi rebuilds every `/new` session from `settings.json` (`defaultModel`, `defaultThinkingLevel`) or the CLI flags it was started with, so a model picked with `/model` or ctrl+p is dropped the moment you start a fresh session. `/resume` and `/fork` restore the target session's own model and are not affected.

`inherit-model.ts` stashes the active provider / model id / thinking level on the `session_shutdown` that precedes a `/new`, and reapplies it on the paired `session_start`. The value is parked on `globalThis` because `/new` recreates the resource loader and every extension instance, so module state would not survive. It is consumed once and never leaks into a later `/new`. If the model has vanished from the registry or its provider has no auth configured, pi's default is left alone. To go back to stock behavior, run `pi config` and untick it, or add `"extensions": ["!extensions/inherit-model.ts"]` to the preset's `packages[]` entry.

## What Sync preset does

1. **Declares 12 required extensions** (plus any checked optional ones) in `~/.pi/agent/settings.json` `packages[]`.
2. **Sets 2 config keys** across two JSON files (see below).
3. **Moves a local `extensions/vibrant-footer/`** into `extensions-disabled/` if one exists, so the footer does not load twice.
4. **Installs the font** when it is missing.

Every step is idempotent. A second run reports "already in sync" and touches nothing — not even file mtimes.

### The 12 required extensions

| Package | |
|---|---|
| `npm:pi-wtf` | `npm:@lll9p/pi-better-compaction` |
| `npm:pi-workspace-history` | `npm:pi-web-search` |
| `npm:@ff-labs/pi-fff` | `git:github.com/code-yeongyu/pi-apply-patch` |
| `npm:pi-tool-display` | `npm:@juicesharp/rpiv-todo` |
| `npm:pi-context-view` | `npm:@juicesharp/rpiv-ask-user-question` |
| `npm:pi-btw` | `npm:pi-patty-bg-tasks` |

Web search is `pi-web-search` only. It uses the selected model provider's native search (Gemini grounding, xAI, OpenAI Responses, Anthropic), so no separate search API key is needed. `pi-web-access` was dropped because it registers the same tool names; pi treats a duplicate tool name as a fatal load error, so the two cannot coexist.

### The optional extension

| Package | Why opt-in |
|---|---|
| `npm:@narumitw/pi-chrome-devtools` | Drives a running Chrome over the DevTools Protocol |

It appears as an unchecked box at the start of every sync. Checking it adds it to the desired set for that run; when already installed it shows as checked and locked.

They are declared as **independent `packages[]` entries**, not bundled inside this package. That is deliberate: `pi update --extensions` only iterates sources listed in `settings.json`, so bundling them would freeze their versions forever. As independent entries, each one keeps its native update behavior.

### The 2 config keys

Written to `extensions/pi-tool-display/config.json`:

```json
{ "registerToolOverrides": { "bash": false } }
```

Written to `keybindings.json`:

```json
{ "tui.editor.cursorLeft": ["left"] }
```

Nothing else is written. Every consumer falls back per key to its own defaults, so a partial file is valid and no upstream default can be frozen by a stale snapshot.

Writes to both files are a deep merge of exactly those leaf keys — never a whole-file overwrite. If a file does not parse as JSON, only that step aborts, rather than starting from `{}` and erasing your hand-tuned settings. The previous content is copied to `<file>.preset-bak` before every write, and the write itself is a tmp-file rename so an interrupted run cannot truncate it.

#### Why these keys exist: `pi-patty-bg-tasks`

[`pi-patty-bg-tasks`](https://pi.dev/packages/pi-patty-bg-tasks) brings Claude Code's background-task flow to pi: a foreground command that runs past 120s slides into the background, **Ctrl+B** backgrounds it on demand, and `jobs` / `monitor` / `agent_bg` / `/bg-list` manage what is running. It collides with the rest of the preset in two places.

**1. The `bash` tool — this one is fatal.** Both `pi-patty-bg-tasks` and `pi-tool-display` register a `bash` override, and pi treats a duplicate tool name as a load **error**, not a precedence question:

```
Error: Failed to load extension ".../pi-patty-bg-tasks/index.ts": Tool "bash" conflicts with .../pi-tool-display/index.ts
Hint: Start without extensions using "pi -ne".
```

pi exits 1 and does not start. Reordering `packages[]` does not help. Setting `registerToolOverrides.bash: false` is `pi-tool-display`'s own documented opt-out and leaves every other tool it renders (`read`, `grep`, `find`, `ls`, `edit`, `write`) untouched. Ownership changes only take effect after a restart or `/reload`.

To keep `pi-tool-display`'s bash rendering instead, set that key back to `true` **and** drop `npm:pi-patty-bg-tasks` from `packages[]` — keeping both with `true` makes pi unstartable.

**2. The Ctrl+B keybinding.** pi binds `ctrl+b` to `tui.editor.cursorLeft` by default (an emacs-style alias for `left`), and the extension registers `ctrl+b` unconditionally. The extension wins the key either way — this is only cosmetic — but pi prints `Extension shortcut conflict: 'ctrl+b' ...` on every startup until the built-in claim is dropped. A user key list **replaces** the default list rather than extending it, so `["left"]` is what removes `ctrl+b`.

To keep the emacs binding and live with the warning, restore `"tui.editor.cursorLeft": ["left", "ctrl+b"]`. The extension's other shortcuts (`ctrl+shift+b`, `ctrl+shift+j`, `shift+down`, `ctrl+shift+x`) collide with nothing.

**3. Headless children die on the first `bash` call.** This one is why `extensions/headless-keepalive.ts` ships. `pi-patty-bg-tasks` spawns its foreground `bash` with `detached: true` + `proc.unref()` and `unref()`s every timer. In the TUI the terminal keeps Node's event loop alive, so nothing is noticed. In a headless `pi -p` process (Trellis `trellis_subagent` workers, pi-patty's own `agent_bg`, anything driving `--mode json|text`) the loop is empty once stdin is drained and the LLM stream ends, so Node exits **0** mid tool-call: no `tool_execution_end`, no `agent_end`, empty or first-turn-only output. Verified on 1.1.6: `pi -p --no-extensions -e …/pi-patty-bg-tasks` reproduces it, built-in bash does not.

The keepalive extension holds one ref'd `setInterval` per in-flight tool call (`tool_execution_start` → `tool_execution_end`) and releases everything on `agent_end` / `session_shutdown`. It registers no tool and no command, so it never appears in the footer's package count. Drop it once upstream stops unref'ing the foreground child.

`settings.json` `packages[]` is **append-only**: entries are deduplicated by pi's own identity rule (npm compares the package name, git compares the repository URL without its ref), and packages you added yourself are never reordered or removed.

## Font

The footer uses Nerd Fonts v3 Material Design glyphs (`nf-md-*`). Without a Nerd Font they render as tofu.

The sync flow detects the family **`Maple Mono NF CN`** and skips when present. Detection is a purely local check — `fc-list` where available, otherwise a scan of the platform font directories — so a machine that already has the font issues no network request and keeps whatever build it has.

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
- **No automatic `pi install`.** The sync flow only writes `packages[]` and lets pi install on its next start.

  > **Restart pi after a sync that changed `packages[]`.** Extensions get no access to pi's settings manager, so the write goes straight to the file while the running session still holds the array it loaded at startup. If you use `/config` or `pi install` in that same session afterwards, pi persists its stale snapshot and the newly added entries disappear. Re-running the sync restores them; nothing else is lost.
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
