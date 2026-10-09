# pi-preset

Personal [pi](https://pi.dev) environment as a pi package: a theme-reactive status bar, a curated extension set, the two non-default config keys (the ones that keep the background-task and tool-display extensions from fighting over `bash`), and a `models.json` template for OpenAI / Anthropic / DeepSeek relays.

Reproduces the base working setup on a new machine in two commands, without shipping a single credential; the optional upstream grilling workflow has its own explicit sync command.

## Bootstrap

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi, then run:

```
/pi-preset
```

`/pi-preset` is the preset's single visual control panel — a TUI menu with four entries:

1. **Sync preset** — packages, config keys, and footer. Starts with a package checklist (optional extensions, plus every installed package that is not part of the preset — unchecked, i.e. removed, by default), then shows a diff of everything it would change and writes nothing until you confirm.
2. **Install / refresh grilling skills** — the optional upstream grilling workflow.
3. **Apply models.json template** — replaces `~/.pi/agent/models.json` with the preset's providers and sets the default provider and model (see [models.json template](#modelsjson-template)).
4. **Install the Maple Mono NF CN font (ask pi)** — sends a font-install prompt to the current model (see [Font](#font)).

After a sync that added or removed packages, restart pi so the new package set loads — and do that before touching `/config` in the same session (see [Design notes](#design-notes)).

Once pi can talk to a model, pick **Install the Maple Mono NF CN font** in `/pi-preset` to have it install the font the status bar needs (see [Font](#font)).

## Optional extensions

`@narumitw/pi-chrome-devtools` is **not installed by default**: it drives a real browser, which not every machine wants. The sync flow opens with a checklist where you tick the ones this machine should have. Already-installed entries start checked; unchecking one removes it (see [Packages outside the preset](#packages-outside-the-preset)).

`pi-playwright` used to sit next to it and was dropped: Chrome DevTools already covers navigate / evaluate / screenshot against a live browser without Playwright's own browser downloads.

## models.json template

The **Apply models.json template** menu entry writes [`templates/models.json`](templates/models.json) over `~/.pi/agent/models.json`. The template carries three providers with every model, compat flag, thinking-level map, context limit, modality, and price filled in. Only the endpoint and the key are placeholders:

| Provider | API | Models | Placeholder `baseUrl` | Placeholder `apiKey` |
|---|---|---|---|---|
| `openai-proxy` | `openai-responses` | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | `https://your-openai-relay.example.invalid/v1` | `$OPENAI_PROXY_API_KEY` |
| `anthropic-proxy` | `anthropic-messages` | Claude Fable 5.1, Claude Opus 5.5, Claude Opus 4.6, Claude Sonnet 5.5 | `https://your-anthropic-relay.example.invalid` | `$ANTHROPIC_PROXY_API_KEY` |
| `deepseek-proxy` | `openai-responses` | DeepSeek V4.1 Flash | `https://your-deepseek-relay.example.invalid/v1` | `$DEEPSEEK_PROXY_API_KEY` |

The flow (TUI only):

1. **Fill in or keep.** Either enter a base URL and API key for each provider (the key prompt is masked), or skip the prompts. An empty answer, and every provider when you skip, keeps the provider's current value from your existing `models.json`, or the template placeholder when there is none. A key written as `$NAME` is read by pi from that environment variable, so the placeholders already work if you export `OPENAI_PROXY_API_KEY` and so on.
2. **Default provider and model.** Two selectors pick `defaultProvider` and `defaultModel` for `settings.json`. The template's defaults, [`templates/settings.json`](templates/settings.json) (`anthropic-proxy` / `claude-opus-5-5`), come first.
3. **Review.** A summary lists the file being replaced, providers that disappear because they are not in the template, each provider's endpoint and where its key comes from, the two `settings.json` keys, and any placeholders left. Keys are never shown. Enter applies, Esc writes nothing.

`models.json` is replaced as a whole: the previous file is kept as `models.json.preset-bak`, the new one is written atomically with mode `0600`. Only `defaultProvider` and `defaultModel` are merged into `settings.json`; everything else there stays. Running it again with the same answers writes nothing. Open `/model` afterwards to load the models; the new default applies from the next pi start.

The providers target subscription relays (a ChatGPT or Claude subscription exposed as an API by a relay), so their parameters follow the subscription catalogs rather than the pay-as-you-go API ones:

- **OpenAI** thinking levels use the ChatGPT-subscription (`openai-codex`) mapping: `minimal` is served as `low`. GPT-6 Astra and GPT-6.1 Sol cannot disable reasoning, so `off` is unavailable for them. Context stays at the subscription's 272k.
- **Compatibility flags** mirror what pi's bundled catalog enables for these models and were verified end to end through two different subscription relays:
  - OpenAI: `supportsOpenAIGrammarTools` (grammar-constrained tools go out as native OpenAI custom tools) and `supportsMidConvoSystemMessages` (mid-conversation developer messages stay in place instead of being folded into the leading system prompt, which would break the cached prefix).
  - Anthropic: `supportsMidConvoEffort` (changing the thinking level mid-session keeps the prompt cache and binds thinking blocks), `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, and `supportsEagerToolInputStreaming`. Claude Opus 4.6 turns the three mid-conversation flags off.

  If your relay rejects one of the enabled flags, set it to `false` in `models.json` after applying the template.

To add another provider, edit `models.json` by hand or ask pi to do it; pi's own `docs/models.md` describes the format. Re-applying the template removes providers that are not in it, so keep a copy of hand-added ones.

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
| `extensions/pi-preset.ts` | The `/pi-preset` control panel: sync, skills, the models.json template, and the font-install prompt in one TUI menu |
| `templates/models.json`, `templates/settings.json` | The provider template (placeholder endpoints and keys) and its default provider/model |
| `extensions/headless-keepalive.ts` | Keeps headless `pi -p` children alive during tool calls (works around a `pi-patty-bg-tasks` bug, see below). No command, no UI |
| `extensions/bash-bg-cap.ts` | Moves stuck foreground `bash` commands to the background after 30s (no timeout given) or at most 60s, instead of the model's multi-minute timeouts (see below). No command, no UI |
| `extensions/cache-retention.ts` | Defaults `PI_CACHE_RETENTION` to `long` inside pi (1h Anthropic cache TTL, 24h OpenAI Responses retention) so it applies even in shells that never sourced your rc file. An explicit value in the environment wins. No command, no UI |
| `extensions/idle-keepwarm.ts` | Keeps the Anthropic prompt cache warm while pi's UI stays open and idle, past pi's own 30-minute idle limit (see below). Status bar segment `keepwarm`, no command |
| `extensions/inherit-model.ts` | `/new` keeps the model and thinking level you were just using instead of falling back to `defaultModel` (see below). No command, no UI |

### Reading the status bar

```
✧ ~/project · ⎇ main
▰▱▱▱▱▱ 58k/272k 21% · ↑ 48k ↓ 38k · ▤ 1.1M ↻ 90k ◎ 93% · ⧗ 47m ♨ 21:43 ×2      provider · π model · ◆ high
◈ $0.410 · ◷ 36m52s
⬡ 12 · ⧉ 2·14 cm ts · ☑ 1/3 · ▸ current task
```

Segments show icons only. Set `PI_PRESET_FOOTER_LABELS=1` to bring back the word labels (`in`, `out`, `cache r`, `w`, `hit`, `ttl`, `warm`, `pkg`, `mcp`); they are then shown whenever the stats fit in two lines. The list below uses those label names.

- **Context**: the meter plus `used/window percent` of the current context. Its color turns warning above 70% and error above 90%.
- **in / out**: input and output tokens summed over the whole session, not the current context.
- **cache r / w / hit**: session totals of cache-read and cache-write tokens, and the latest turn's cache hit rate.
- **ttl / warm**: time left before the prompt-cache entry expires (warning-toned in the last 5 minutes), and when `idle-keepwarm` refreshes it next, with the number of refreshes since your last message. A dim note replaces both while warming is paused.
- **◈**: session cost as `$0.410` (`sub` when the model runs on an OAuth subscription), or `Σ` total tokens when the provider reports no price.
- **mcp servers·tools**: MCP servers connected through pi's built-in MCP support and their callable tools. Servers that failed or need a sign-in are not counted; pi reports them after startup and in `/mcp`. A dim `mcp 0` means MCP support is loaded but no server is connected. `cm` / `ts` mark the built-in `codemode` / `tool_search` tools while they are active. The segment is hidden only when the built-in MCP extension is disabled.


### Prompt cache kept warm while idle

pi's own cache warmer (`cacheWarming`, default `"streaming"`) only refreshes during runs, and its `"idle"` mode stops 30 minutes after the last real request — before a 1h cache entry would first be refreshed at 54 minutes. `extensions/cache-retention.ts` turns on the 1h TTL, and `extensions/idle-keepwarm.ts` covers the idle gap:

- Every real Anthropic request is captured. While the agent is idle, at 90% of the TTL the same payload is re-sent with `max_tokens: 1`. Nothing enters the conversation; each refresh is a `pi-preset-keepwarm` custom entry in the session file, and the status bar shows the remaining TTL and the next refresh time (see [Reading the status bar](#reading-the-status-bar)).
- The TTL comes from the model's `promptCache` (the Anthropic templates declare `{ "short": 300, "long": 3600 }`) and the request's `cache_control` TTL.
- A refresh that would fire within 5s of expiry (after sleep) is skipped, and one that misses the cache stops warming with a warning: on a Claude subscription the cache write is the billed part. Model switch, compaction, and `/tree` navigation pause warming; the next message re-arms it.
- `PI_PRESET_KEEPWARM=off` disables it; `PI_PRESET_KEEPWARM_MAX_IDLE=3h` stops after that long without a real request (default: no limit). Only interactive sessions are warmed.

Behind a gateway that load-balances several accounts, enable session stickiness, or every refresh lands on an account without the entry and the miss guard stops warming.

The Anthropic templates set `cacheRead` to `0`, because Claude subscription gateways do not bill cache reads.

### `/new` inherits the current model

pi rebuilds every `/new` session from `settings.json` (`defaultModel`, `defaultThinkingLevel`) or the CLI flags it was started with, so a model picked with `/model` or ctrl+p is dropped the moment you start a fresh session. `/resume` and `/fork` restore the target session's own model and are not affected.

`inherit-model.ts` stashes the active provider / model id / thinking level on the `session_shutdown` that precedes a `/new`, and reapplies it on the paired `session_start`. The value is parked on `globalThis` because `/new` recreates the resource loader and every extension instance, so module state would not survive. It is consumed once and never leaks into a later `/new`. If the model has vanished from the registry or its provider has no auth configured, pi's default is left alone. To go back to stock behavior, run `pi config` and untick it, or add `"extensions": ["!extensions/inherit-model.ts"]` to the preset's `packages[]` entry.

## What Sync preset does

1. **Declares 12 required extensions** (plus any checked optional ones) in `~/.pi/agent/settings.json` `packages[]`, and **removes every other entry you did not check to keep** (see [Packages outside the preset](#packages-outside-the-preset)).
2. **Sets 5 config keys** across three JSON files (see below).
3. **Moves a local `extensions/vibrant-footer/`** into `extensions-disabled/` if one exists, so the footer does not load twice.

Every step is idempotent. A second run reports "already in sync" and touches nothing — not even file mtimes.

### The 12 required extensions

| Package | |
|---|---|
| `npm:pi-wtf` | `npm:@lll9p/pi-better-compaction` |
| `npm:pi-workspace-history` | `npm:pi-web-search` |
| `npm:@ff-labs/pi-fff` | `git:github.com/code-yeongyu/pi-apply-patch` |
| `npm:pi-tool-display` | `npm:@juicesharp/rpiv-todo` |
| `npm:pi-context-view` | `npm:@juicesharp/rpiv-ask-user-question` |
| `npm:@narumitw/pi-btw` | `npm:pi-patty-bg-tasks` |

`pi-apply-patch` stays required: pi has no built-in `apply_patch`. Its Codex Lark grammar only reaches the model once the tool declares it through pi's `constrainedSampling` API ([code-yeongyu/pi-apply-patch#43](https://github.com/code-yeongyu/pi-apply-patch/pull/43)). Until that lands, it goes out as a plain function tool even though the OpenAI template enables `supportsOpenAIGrammarTools`. The flag is harmless in the meantime and takes effect after an update.

Web search is `pi-web-search` only. It uses the selected model provider's native search (Gemini grounding, xAI, OpenAI Responses, Anthropic), so no separate search API key is needed. `pi-web-access` was dropped because it registers the same tool names; pi treats a duplicate tool name as a fatal load error, so the two cannot coexist.

### Native compaction

`pi-better-compaction` replaces pi's text summary with the provider's own server-side compaction where the API offers one, and falls back to pi's compaction whenever that fails:

- **OpenAI Responses** (`openai-responses`): native `/responses/compact`. The result is an opaque window that replays only for the provider and model that produced it.
- **Anthropic Messages** (`anthropic-messages`): on-demand compaction (beta `compact-2026-09-04`, Claude Sonnet 4.6 / Opus 4.6 and newer, not Haiku). The signed block replays for the same model; its text also becomes pi's summary, so other models can still read it.
- Everything else keeps pi's compaction.

Whether native compaction actually runs depends on the relay. CLIProxyAPI (verified on 8.0.8) passes the beta through but adds `context_management` to every thinking request, which Anthropic refuses next to `compaction`. pi always sends thinking for the preset's Anthropic models, so before 0.7.3 every Anthropic compaction through CLIProxyAPI fell back to pi's. Since 0.7.3 the package retries that one rejected request without thinking ([lll9p/pi-better-compaction#9](https://github.com/lll9p/pi-better-compaction/pull/9); thinking blocks already in the history are kept, later turns keep your thinking level). If you installed an earlier version of this preset, leave the old `git:github.com/zidou-kiyn/pi-better-compaction` entry unchecked under *Packages not in the preset*: pi identifies git packages by URL, so both copies would otherwise load and both handle compaction.

**Switching models after an OpenAI native compaction.** The new model cannot read the opaque window and continues from the kept messages only. The package warns when this happens ([#10](https://github.com/lll9p/pi-better-compaction/pull/10)). To give the new model the full history, use `/tree` to branch from the entry just before that compaction; pi rebuilds the context from the original messages and compacts again with the new model if it does not fit. Switching away from an Anthropic compaction is safe.

To check what happened, run `/compact` and look at the session's compaction entry: `details.strategy` is `anthropic-native-compact-v1` or `openai-native-compact-v*` for native compaction, and absent for pi's own. For the reason behind a fallback, set `"debug": true` in `~/.pi/agent/extensions/pi-better-compaction/config.json`.

### Packages outside the preset

`packages[]` is managed as a **whitelist**. The sync checklist lists every installed entry that is neither required, optional, nor the preset itself, under *Packages not in the preset*, **unchecked**. Check the ones this machine should keep; everything left unchecked is removed. Unchecking an installed optional extension removes it the same way.

- **Nothing is written from the checklist.** The plan that follows lists each removal as a `- remove` line with its reason, and needs the usual confirmation.
- **The preset never removes itself**, whether it was installed as `git:github.com/zidou-kiyn/pi-preset` (any ref) or from a local path pointing at this package.
- **Removal goes through `pi remove <source>`**, so npm packages are uninstalled and git checkouts deleted exactly as pi would do it by hand. Its output is captured so it cannot print over the TUI. For a local-path entry only the `settings.json` entry is removed; the directory is left alone.
- **Matching is by package identity**: `npm:pi-btw@0.6.1` and `{ "source": "npm:pi-btw", ... }` are the same package, listed once and removed together.
- If `pi remove` fails, the entry is still removed from `settings.json` and the result says which files may remain.
- **RPC and print modes never remove anything**: with no checklist there is no consent, so they only add.

This is also how the old `npm:pi-btw` goes away after the switch to `npm:@narumitw/pi-btw` (both register `/btw`): it shows up unchecked under *Packages not in the preset*.

### The optional extension

| Package | Why opt-in |
|---|---|
| `npm:@narumitw/pi-chrome-devtools` | Drives a running Chrome over the DevTools Protocol |

It appears as an unchecked box at the start of every sync. Checking it adds it to the desired set for that run; when already installed it starts checked, and unchecking it removes it.

They are declared as **independent `packages[]` entries**, not bundled inside this package. That is deliberate: `pi update --extensions` only iterates sources listed in `settings.json`, so bundling them would freeze their versions forever. As independent entries, each one keeps its native update behavior.

### The 5 config keys

Written to `extensions/pi-tool-display/config.json`:

```json
{ "registerToolOverrides": { "bash": false } }
```

Written to `keybindings.json`:

```json
{ "tui.editor.cursorLeft": ["left"] }
```

Written to `settings.json`, next to `packages[]`:

```json
{
  "tuiMode": "fullscreen",
  "fullscreenWheelScrollLines": "auto",
  "fullscreenCopyOnSelect": false
}
```

This turns on pi's fullscreen TUI. `"auto"` adapts wheel speed to the terminal (one line per event on local macOS, accelerated up to 6 elsewhere and over SSH). With copy-on-select off, selecting text no longer overwrites the clipboard; press `ctrl+x` (`app.message.copy`) to copy the active selection. Like any `settings.json` change made by the sync, it takes effect after a restart.

Nothing else is written. Every consumer falls back per key to its own defaults, so a partial file is valid and no upstream default can be frozen by a stale snapshot.

Writes to all three files are a deep merge of exactly those leaf keys — never a whole-file overwrite. If a file does not parse as JSON, only that step aborts, rather than starting from `{}` and erasing your hand-tuned settings. The previous content is copied to `<file>.preset-bak` before every write, and the write itself is a tmp-file rename so an interrupted run cannot truncate it.

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

**4. Models hold the session with huge `bash` timeouts.** This is why `extensions/bash-bg-cap.ts` ships. Under `pi-patty-bg-tasks`, `bash`'s `timeout` is when a foreground command slides into the background (the model then gets `job_decide`: keep / kill / check), not when it is killed. Models read it as a kill deadline and pass hundreds of seconds to protect long builds, so a hung command holds the session for minutes. The extension rewrites each `bash` call before it runs:

| Model passed | Runs with |
|---|---|
| no `timeout` | 30s (`PI_PRESET_BASH_BG_DEFAULT`) |
| `timeout` above 60s | 60s (`PI_PRESET_BASH_BG_CAP`) |
| `timeout` at or below 60s | unchanged, never raised |
| `run_in_background: true` | unchanged |
| a command starting with `sleep` | unchanged: patty **kills** those at the timeout instead of backgrounding them |

The rewrite happens on the finalized assistant message (`message_end`), which pi shares between the tool row, the tool loop, and the saved transcript, so the row reads `(timeout 60s)` rather than the model's original number, and the recorded call shows 60 too. So that the model doesn't take the rewritten argument for its own mistake, the extension adds one bullet to the bash guidelines in the system prompt, and capped results end with a single `[pi-preset] bash timeout capped: 150s -> 60s` line. A `tool_call` hook caps the executed copy as well, covering calls that never pass through an assistant message (codemode scripts).

Nothing gets killed because of this: a capped build keeps running in the background and reports when it ends. While the model waits on it with `jobs attach`, Esc only stops the waiting; the job keeps going. Set either variable to `off` to disable the extension.

It only acts when the registered `bash` tool comes from `pi-patty-bg-tasks` (checked through the tool's `sourceInfo.path`). With pi's built-in `bash`, `timeout` **is** a kill deadline, and capping it would kill long builds. It also stays out of print/json modes, where patty ignores the timeout anyway.

The keepalive extension holds one ref'd `setInterval` per in-flight tool call (`tool_execution_start` → `tool_execution_end`) and releases everything on `agent_end` / `session_shutdown`. It registers no tool and no command, so it never appears in the footer's package count. Drop it once upstream stops unref'ing the foreground child.

`settings.json` `packages[]` is a **whitelist**: entries are matched by pi's own identity rule (npm compares the package name, git compares the repository URL without its ref), missing preset packages are appended, existing entries are never reordered, and a package outside the preset is removed only when you left it unchecked in the sync checklist and confirmed the plan (see [Packages outside the preset](#packages-outside-the-preset)).

## Font

The footer uses Nerd Fonts v3 Material Design glyphs (`nf-md-*`). Without a Nerd Font they render as tofu. The preset uses **Maple Mono NF CN** ([subframe7536/maple-font](https://github.com/subframe7536/maple-font/releases/latest), asset `MapleMono-NF-CN-unhinted.zip`).

The preset does not install fonts itself: the right method differs per OS, per distribution, and per terminal emulator. Instead, once a model is configured and pi answers, pick **Install the Maple Mono NF CN font (ask pi)** in `/pi-preset`. It sends this prompt as your message (queued as a follow-up if a run is in progress; refused with a hint when no model is selected yet), and the model does everything with its normal tools: installs the font if missing, finds the terminal pi runs in, and sets that terminal's font in its config file (backing the file up first):

```
Set up the Maple Mono NF CN font for me end to end; do every step yourself, do not hand any step back to me.
1. Check whether it is already installed for my operating system; if it is, skip to step 3.
2. Download MapleMono-NF-CN-unhinted.zip from the latest release of github.com/subframe7536/maple-font, install it for my user only (no sudo/administrator rights), and refresh the font cache if my OS has one.
3. Find out which terminal emulator this pi session runs in (environment variables such as TERM_PROGRAM, the parent process chain, or the terminal's config files), and set its font to "Maple Mono NF CN" in that terminal's own configuration, backing up any config file before you change it.
4. Verify the font is installed and the terminal config now names it, then report what you changed and whether the terminal must be restarted or a new window opened for the font to show.
```

You can also paste it yourself. The text lives in [`src/font-prompt.ts`](src/font-prompt.ts). Afterwards, restart the terminal or open a new window if the model says so.

## Git ref semantics

The `packages[]` entry for this package deliberately carries **no `@ref`**:

```
git:github.com/zidou-kiyn/pi-preset
```

pi only reconciles a git source to its *configured* ref and never advances it on its own. Omitting the ref means the clone follows the default branch, so `pi update --extensions` picks up new commits. Pinning a tag here would mean every change required editing `settings.json` on every machine.

## Design notes

- **Few personal preferences are shipped.** The sync flow sets only the fullscreen TUI keys above besides `packages[]`. `defaultProvider` and `defaultModel` are written only when you apply the models.json template, and you pick them there. No `theme`, no `defaultThinkingLevel`, no `AGENTS.md`.
- **No credentials, ever.** The models template holds only placeholder endpoints and `$ENV_VAR` keys. `scripts/scan-secrets.sh` scans the working tree and the full git history before every push.
- **No automatic `pi install`.** The sync flow only writes `packages[]` and lets pi install on its next start. (Removals are the exception: they run `pi remove` so the installed files go too.)

  > **Restart pi after a sync that changed `packages[]`.** Extensions get no access to pi's settings manager, so the write goes straight to the file while the running session still holds the array it loaded at startup. If you use `/config` or `pi install` in that same session afterwards, pi persists its stale snapshot and the newly added entries disappear (or removed ones come back). Re-running the sync fixes it; nothing else is lost.
- **MCP, codemode, and tool search are left to pi.** Since 0.99, pi ships them as built-in extensions: servers live in `~/.pi/agent/mcp.json` and are managed with `/mcp`, while `codemode` and `tool_search` switch on by themselves when an MCP server needs them. The preset writes no `mcp.json` and no `defaultTools`. MCP servers carry credentials and differ per person, and codemode is not worth keeping on without MCP, because the models already call tools in parallel natively. None of the required extensions collide with the built-ins. The footer shows what is connected.
- **No runtime dependencies.**
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
