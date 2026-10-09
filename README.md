# pi-preset

Personal [pi](https://pi.dev) environment as one pi package: a theme-reactive status bar, the extension set I work with (vendored and maintained here), the `grill-me` / `grilling` skills, the chrome-devtools MCP server, and a `models.json` template for OpenAI / Anthropic / DeepSeek relays.

Reproduces the working setup on a new machine in two commands, without shipping a single credential. Updating this one package (`pi update git:github.com/zidou-kiyn/pi-preset`) updates every extension in it.

## Bootstrap

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi, then run:

```
/pi-preset
```

`/pi-preset` is the preset's single visual control panel — a TUI menu with three entries:

1. **Sync preset** — config keys, the chrome-devtools MCP server, and `packages[]` cleanup. Starts with a checklist of installed packages that are not part of the preset (unchecked, i.e. removed, by default), then shows a diff of everything it would change and writes nothing until you confirm.
2. **Apply models.json template** — replaces `~/.pi/agent/models.json` with the preset's providers and sets the default provider and model (see [models.json template](#modelsjson-template)).
3. **Install the Maple Mono NF CN font (ask pi)** — sends a font-install prompt to the current model (see [Font](#font)).

After a sync that removed packages, restart pi — and do that before touching `/config` in the same session (see [Design notes](#design-notes)).

For SSH through your Termius hosts, run `/termius setup` and `/termius login` once (see [SSH](#ssh-the-termius-mcp-server)).

### Migrating from 0.1

0.1 installed every extension as its own `packages[]` entry; 0.2 loads them from this package. pi refuses to start when two extensions register the same tool name, so on every machine the old entries must go **after** the preset is updated and **before** pi starts again. Close every pi session first, then:

```bash
pi update git:github.com/zidou-kiyn/pi-preset    # only the preset; plain `pi update` updates pi itself
cd ~/.pi/agent/git/github.com/zidou-kiyn/pi-preset   # Windows: cd $HOME\.pi\agent\git\github.com\zidou-kiyn\pi-preset
node scripts/migrate-vendored.ts                 # dry run: lists what it would change
node scripts/migrate-vendored.ts --apply         # then do it
```

The script needs nothing beyond the Node.js pi already requires. It removes the superseded `packages[]` entries, moves the upstream-installed `grill-me` / `grilling` copies out of `~/.agents/skills` (they would shadow the bundled ones) and drops them from the skills lock file, and moves the leftover `extensions/pi-tool-display` and `extensions/pi-permission-system` data directories. Nothing is deleted: everything goes to `~/.pi/agent/preset-migration-backup/<timestamp>/`. Then start pi, run **Sync preset** in `/pi-preset` once (MCP config, remaining cleanup), and restart pi. Later syncs also remove any superseded entry that comes back.

If pi was started in between and stopped with `Tool "…" conflicts with …`, just run the script and start again.

## models.json template

The **Apply models.json template** menu entry writes [`templates/models.json`](templates/models.json) over `~/.pi/agent/models.json`. The template carries three providers with every model, compat flag, thinking-level map, context limit, modality, and price filled in. Only the endpoint and the key are placeholders:

| Provider | API | Models | Placeholder `baseUrl` | Placeholder `apiKey` |
|---|---|---|---|---|
| `openai-proxy` | `openai-responses` | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | `https://your-openai-relay.example.invalid/v1` | `$OPENAI_PROXY_API_KEY` |
| `anthropic-proxy` | `anthropic-messages` | Claude Fable 5.1, Claude Opus 5.5, Claude Opus 4.6, Claude Sonnet 5.5 | `https://your-anthropic-relay.example.invalid` | `$ANTHROPIC_PROXY_API_KEY` |
| `deepseek-proxy` | `openai-responses` | DeepSeek V4.1 Flash, DeepSeek V4 Pro | `https://your-deepseek-relay.example.invalid/v1` | `$DEEPSEEK_PROXY_API_KEY` |

The flow (TUI only):

1. **Fill in or keep.** Either enter a base URL and API key for each provider (the key prompt is masked), or skip the prompts. An empty answer, and every provider when you skip, keeps the provider's current value from your existing `models.json`, or the template placeholder when there is none. A key written as `$NAME` is read by pi from that environment variable, so the placeholders already work if you export `OPENAI_PROXY_API_KEY` and so on.
2. **Default provider and model.** Two selectors pick `defaultProvider` and `defaultModel` for `settings.json`. The template's defaults, [`templates/settings.json`](templates/settings.json) (`anthropic-proxy` / `claude-opus-5-5`), come first.
3. **Review.** A summary lists the file being replaced, providers that disappear because they are not in the template, each provider's endpoint and where its key comes from, the two `settings.json` keys, and any placeholders left. Keys are never shown. Enter applies, Esc writes nothing.

`models.json` is replaced as a whole: the previous file is kept as `models.json.preset-bak`, the new one is written atomically with mode `0600`. Into `settings.json` go `defaultProvider`, `defaultModel`, and the template's `modelThinkingLevels` for models that have no level yet: Claude Fable 5.1 starts at `high`, its official default (pi's global default is `medium`). A level you saved yourself (Ctrl+S in `/thinking`) is never replaced; everything else in `settings.json` stays. Running it again with the same answers writes nothing. Open `/model` afterwards to load the models; the new default applies from the next pi start.

The providers target subscription relays (a ChatGPT or Claude subscription exposed as an API by a relay), so their parameters follow the subscription catalogs rather than the pay-as-you-go API ones:

- **OpenAI** thinking levels use the ChatGPT-subscription (`openai-codex`) mapping: `minimal` is served as `low`. GPT-6 Astra and GPT-6.1 Sol cannot disable reasoning, so `off` is unavailable for them. Context stays at the subscription's 272k.
- **Compatibility flags** mirror what pi's bundled catalog enables for these models and were verified end to end through two different subscription relays:
  - OpenAI: `supportsOpenAIGrammarTools` (grammar-constrained tools go out as native OpenAI custom tools) and `supportsMidConvoSystemMessages` (mid-conversation developer messages stay in place instead of being folded into the leading system prompt, which would break the cached prefix).
  - Anthropic: `supportsMidConvoEffort` (changing the thinking level mid-session keeps the prompt cache and binds thinking blocks), `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, and `supportsEagerToolInputStreaming`. Claude Opus 4.6 turns the three mid-conversation flags off.

  If your relay rejects one of the enabled flags, set it to `false` in `models.json` after applying the template.
- **Claude** follows the subscription: 1M context on every listed model, the 1h prompt cache (pi prices 1h cache writes at 2× input on its own), and Opus 5.5 / Sonnet 5.5 marked as rejecting `temperature`, like the official catalog.
- **DeepSeek** is pay-as-you-go, so its prices are DeepSeek's own peak rates (off-peak is half): V4.1 Flash $0.30 / $1.20 / $0.006 cache hit, V4 Pro $1.32 / $3.96 / $0.044 per 1M tokens. Both take `low`, `high`, and `max` (`off` sends `none`); pi's default `medium` runs as `high`, DeepSeek's own default. No cache lifetime is declared, so nothing pays for cache warming.

To add another provider, edit `models.json` by hand or ask pi to do it; pi's own `docs/models.md` describes the format. Re-applying the template removes providers that are not in it, so keep a copy of hand-added ones.

## Extensions

Everything except the preset's own `extensions/` is vendored under [`vendor/`](vendor): a copy of the upstream source at a recorded commit, loaded through `package.json` `pi.extensions`. [`vendor/UPSTREAM.json`](vendor/UPSTREAM.json) records each package's repository, commit, license, and every local change.

| Vendored package | Upstream | What it adds | Local changes |
|---|---|---|---|
| `pi-patty-bg-tasks` 2.0.0 | [patty-io/pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (unreleased `main`) | `bash` override that slides long commands into the background, `bash_bg`, `jobs`, `monitor`, `agent_bg`, ctrl+shift+b | headless fix, 30s/60s foreground timing and live progress (see below), condensed prompt |
| `pi-workspace-history` 0.5.0 | [wcldyx/pi-workspace-history](https://github.com/wcldyx/pi-workspace-history) | file snapshots per turn: `/undo`, `/redo`, `/diff`, `/checkpoint`, file restore on `/tree` | — |
| `pi-wtf` 0.3.0 | [travisp/pi-wtf](https://github.com/travisp/pi-wtf) | `/fuck` (`?`, `!`): abort, rewind to before the last prompt, put it back in the editor | lives in `vendor/pi-workspace-history/wtf` |
| `pi-better-compaction` 0.7.4 | [lll9p/pi-better-compaction](https://github.com/lll9p/pi-better-compaction) | provider-native compaction (see below) | — |
| `pi-fff` 0.11.0 | [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff) `packages/pi-fff` | `ffgrep` / `fffind`: frecency-ranked, git-aware search | condensed prompt; native library stays an npm dependency |
| `rpiv-todo` 2.12.0 | [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `todo` task list and overlay | condensed prompt |
| `rpiv-ask-user-question` 2.12.0 | same | `ask_user_question` structured questions (up to 4 per call) | condensed prompt |
| `pi-web-search` 1.7.0 | [ttttmr/pi-web-search](https://github.com/ttttmr/pi-web-search) | `web_search` through the current provider's native search; no extra API key | — |
| `pi-apply-patch` 0.1.4 | [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch) | Codex `apply_patch` for OpenAI models | `typebox` as a peer dependency |
| `pi-context-view` 0.6.0 | [dimk90/pi-context-view](https://github.com/dimk90/pi-context-view) | `/context`: what fills the context, including tool definitions and injections | — |
| `termius-mcp` 3.1.0 | [MiaM1ku/termius-mcp](https://github.com/MiaM1ku/termius-mcp) | Python MCP server: SSH into Termius hosts (see [SSH](#ssh-the-termius-mcp-server)) | no secret-bearing tools, output redaction, pinned host keys, stdin login |

All of them are MIT-licensed except termius-mcp (BSD 3-clause, from the Termius CLI); each directory keeps its upstream LICENSE (or the repository's, for monorepo packages).

`/fuck` and workspace-history work together: the rewind goes through pi's tree navigation, which workspace-history intercepts to offer restoring the files to the same point. `/undo` does the same for the last finished turn and also puts the prompt back in the editor; `/fuck` additionally aborts a running turn.

### Condensed tool prompts

Four vendored packages have their model-facing text condensed: `ask_user_question`, `todo`, the patty background tools, and `ffgrep` / `fffind`. Upstream repeats the same advice across tools (how to wait without `sleep`, one notification vs. an event stream) and spells out limits the schema and validator already enforce. The condensed text keeps every rule that changes behavior; the tools' code is untouched. Measured with the same request, the fixed per-request context drops from about 9.9k to 8.1k tokens (system-prompt rules from 7.7k to 2.9k characters), and A/B runs of questionnaires, task lists, background builds, and monitors produced the same tool calls as before.

### Following upstream

```bash
npm run upstream -- status                 # upstream commits since each vendored commit
npm run upstream -- diff pi-patty-bg-tasks # the upstream diff for one package
npm run upstream -- pull pi-patty-bg-tasks # three-way merge it into vendor/ (--to REV for a specific tag/commit)
npm run upstream -- check                  # what differs locally from the recorded upstream commit
```

`pull` merges file by file with `git merge-file`: files changed only upstream are replaced, files changed on both sides get conflict markers, and the recorded commit moves. It never commits; review with `git diff`, run `npm test`, and update `localChanges` in `UPSTREAM.json` when a local change is dropped or added. Upstream clones are cached in `~/.cache/pi-preset-upstream`.

### Background commands: `pi-patty-bg-tasks`

Brings Claude Code's background-task flow to pi: a foreground `bash` command that runs past its timeout slides into the background and keeps running, **ctrl+shift+b** (or `/bg`) backgrounds it on demand, every finished job sends one `<task-notification>` the moment it exits, and `jobs` / `monitor` / `agent_bg` / `/bg-list` manage what is running. The vendored copy is the unreleased 2.0.0 from `main` (npm still has 1.1.6): no `job_decide` prompt any more, no ctrl+b binding (so no shortcut conflict with pi's cursor key), signal deaths reported as killed instead of completed. Background tasks are killed when the session ends, including `/reload`.

Four local changes (two replace the workaround extensions 0.1 shipped):

- **Headless `pi -p` no longer exits on the first `bash` call.** Upstream spawns the foreground command detached and `unref()`s it; in a headless process nothing else holds Node's event loop once stdin is drained, so Node exited 0 in the middle of the tool call (Trellis workers, `agent_bg` children, any `--mode json|text` driver). The foreground child now stays ref'd until it finishes or moves to the background.
- **Short foreground waits.** `timeout` is when a command moves to the background, not a kill deadline, but models pass hundreds of seconds to protect long builds and a hung command then held the session. Without a timeout a command moves after 30s (`PI_PRESET_BASH_BG_DEFAULT`), and any timeout is capped at 60s (`PI_PRESET_BASH_BG_CAP`); `off` restores upstream's 120s and no cap. The parameter description and a bash guideline tell the model that the command keeps running. A bare `sleep`, which is killed at the timeout instead, keeps the timeout it was given.
- **Live progress from the first moment.** pi's bash row shows a running `Elapsed` clock and the latest output lines, but only once the tool reports a partial result. Upstream reported nothing for the first 2s and then only when the log grew, so a quiet command (tests, builds, installs) showed neither the clock nor anything else until it ended. The command now reports at once and its log is polled every 250ms. The `(timeout Ns)` on the row is when it moves to the background.
- **Private job logs.** Upstream wrote every command's output to a shared, world-readable `/tmp/pi-bg`, which any other user on the machine could read, or create first and so receive the output. Logs now go to `<tmpdir>/pi-bg-<uid>` (mode 0700, checked to be a real directory owned by you) and each log is 0600.

### Tool rows: `extensions/compact-tools.ts`

pi's own renderers already collapse most tool rows (read shows nothing, bash 5 lines, write 10), but `edit` always draws the whole diff. compact-tools re-registers the built-in `edit` with only its renderers wrapped: a collapsed row shows the first 16 lines (`PI_PRESET_EDIT_LINES`, `off` to disable) and a ctrl+o hint, and expanding shows pi's full diff. The model's tool schema and results are pi's own. It replaces `pi-tool-display`, which also took over `read`/`grep`/`find`/`ls` (activating them next to fff) and wrote ANSI-colored "Thinking:" labels into the saved session.

### MCP servers run in codemode

Both MCP servers below use `exposure: "codemode"`: none of their tools is declared to the model. The model calls them from a `codemode` script (`tools.mcp__chrome_devtools__navigate_page(...)`, `tools.mcp__termius__exec(...)`), finds signatures with `describeNamespace()` / `describeTool()`, and returns only what it needs, so a script can chain several calls and filter large output (page snapshots, logs from many hosts) before anything reaches the context. The tool declarations never change mid-session, and the only standing cost is the one `codemode` tool.

### Browser: the chrome-devtools MCP server

Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) runs through pi's built-in MCP support instead of a browser extension. **Sync preset** adds it to `~/.pi/agent/mcp.json`, pinned (`chrome-devtools-mcp@1.10.1`, via `npx`), with telemetry, CrUX lookups, and update checks off, and codemode exposure (its 30 tools are called from scripts). On the first browser call it starts its own Chrome with a separate profile. Turn it off in `/mcp`; the sync does not own `enabled`. Bump the version in `src/manifest.ts` after reading its changelog.

### SSH: the Termius MCP server

[`vendor/termius-mcp`](vendor/termius-mcp) is [MiaM1ku/termius-mcp](https://github.com/MiaM1ku/termius-mcp) (Python, BSD, a fork of the official Termius CLI), hardened here, and [`extensions/termius.ts`](extensions/termius.ts) installs and registers it. The agent can list your Termius hosts and run commands or move files on them over SSH with the hosts' own usernames, passwords, and keys, without ever seeing those secrets.

```
/termius setup     install the server (one step; installs uv first if neither uv nor Python 3.9+ is there)
/termius login     sign in: email + password, or Google; asks for the 2FA code / app approval when Termius wants one
/termius mode      review | auto | dangerously
/termius proxy     system | off | socks5://… | http://…  (proxy for hosts without a jump host)
/termius sync      pull the host list from Termius Cloud now (sign-in already does this once)
/termius status    install state, account, host count, last sync, mode
/termius logout    sign out and wipe the local host cache
```

**Setup.** The server goes into its own environment under `~/.pi/agent/termius-mcp/venv`, built with [uv](https://docs.astral.sh/uv/) (which also fetches a Python when there is none) or a local Python 3.9+. It works the same on Linux, macOS, and Windows. When a preset update changes the vendored code, the next session reinstalls it.

**Sign-in.** `/termius login` asks in pi's own masked prompts and hands the answers to the server process on stdin (`termius login-json`). They never pass through the model, the MCP protocol, the command line, or the environment. Two-factor accounts are asked for the authenticator code; a "approve this device" request waits until you approve it in the Termius app. The vault password is remembered in the OS keychain (an encrypted file where there is none), so later sessions sync on their own. Signing in also pulls the host list right away, so `/termius status` and the agent see your hosts at once; if that first pull fails, the sign-in still stands and `/termius sync` retries it.

**What the model gets.** Seven tools: `status`, `sync`, `hosts`, `host`, `exec`, `files` (SFTP list/stat/read/get/put/write/mkdir/rm/rename), `inventory`. Compared with upstream:

- No tool takes or returns a secret. The `login`, `login_complete`, and `logout` tools, which took the vault password as a model-visible argument, are gone; `sync` has no password argument; snippets are listed by label only, since their scripts can hold credentials.
- Every result is scrubbed: any identity password, key passphrase, private key, or the vault password in command output or file content becomes `[redacted]`, as does any PEM/OpenSSH private key block.
- Host keys are pinned on first connection in `~/.termius/known_hosts`; a changed key is refused instead of silently accepted (upstream used paramiko's `AutoAddPolicy`).

**Jump hosts and proxies.** Upstream dropped Termius's host chains when syncing, so every host was dialed directly. The server now keeps them and connects the way Termius does: through each jump host in order, each hop with its own credentials and its own pinned host key. A chain set on a group applies to its hosts, and a jump host that has a chain of its own is reached through that chain first. Hosts without a chain can go through a proxy, chosen with `/termius proxy`:

- `system` (the default): pi's `ALL_PROXY`, `HTTPS_PROXY`, or `HTTP_PROXY` (any case), with `NO_PROXY`;
- a URL: `socks5://`, `socks5h://`, `socks4://`, `socks4a://`, or `http://` (CONNECT), `user:password@` allowed. Loopback, private, and link-local addresses and `*.local` names stay direct, unless `proxyBypass` in the server's `config.json` (next to its venv) lists other ones;
- `off`: always direct.

Hosts with a jump host chain reach the first jump host directly, without the proxy. The `host` tool shows the jump hosts, the proxy, and an equivalent `ssh -J …` command, and every `exec` result lists its route.

**Approval modes** (`/termius mode`, saved in `~/.pi/agent/termius-mcp/config.json`, default `auto`):

| Mode | exec | files |
|---|---|---|
| `review` | every command asks | every action asks |
| `auto` | read-only commands run, everything else asks | list/stat/read/get run, write/put/mkdir/rm/rename ask |
| `dangerously` | runs | runs |

The prompt offers *Allow once*, *Allow everything on this host for this session*, or *Deny*. `auto` uses fixed rules, not a model: a command is read-only only when every pipeline segment is an allowlisted read-only program (`ls`, `cat`, `tail`, `grep`, `df`, `ps`, `systemctl status`, `docker ps/logs`, `kubectl get/logs`, `journalctl`, `git log`, …) with no output redirection, command substitution, `sudo`, or backgrounding. Anything unrecognised asks, so a gap in the rules costs a question, never a silent change. Without a UI (`pi -p`), calls that would ask are refused unless the mode is `dangerously`.

**Local guard.** The agent's own tools run as your user, so it could in principle read the server's encrypted cache in `~/.termius`, ask the OS keychain for the vault password, or read the server process. The extension blocks tool calls whose paths or commands point there (`~/.termius`, keychain lookups mentioning termius, `/proc/<pid>/mem|environ`, `gdb -p`, …), and `files put` cannot upload from `~/.termius`. This stops the ordinary ways and makes intent visible; it is not an isolation boundary against an agent deliberately working around it as the same OS user. Running the server as a separate OS user would be that boundary.

## Project memory: trellis-lite

[`extensions/trellis-lite.ts`](extensions/trellis-lite.ts) keeps the useful part of [Trellis](https://github.com/mindfold-ai/Trellis) — specs, the developer journal, and task notes in `.trellis/` — without its workflow machinery. It reads and writes the same files, so a Trellis project keeps its data as it is. The design draws on Trellis and [mini-trellis](https://github.com/Tiger-zzZ/mini-trellis); it is an independent implementation, not a Mindfold product, and shares no code with either (see [`docs/trellis-lite-design.md`](docs/trellis-lite-design.md)).

It acts only in a Trellis project: the nearest directory above the session's working directory (up to the repository root) with a `.trellis/` holding `spec/`, `workspace/`, `tasks/`, or `.developer`. Anywhere else it adds nothing: no prompt text, no skills, no tool-result changes. In a Trellis project:

- **A `project-memory` system prompt section** lists the spec indexes, the journal (with its session and line count), open tasks, and research notes by path, never their contents. It is computed once per session and sent byte for byte on every turn, so the cached prefix holds.
- **Three skills**, offered only in Trellis projects (through pi's `resources_discover`): `trellis-spec` writes a rule that should still hold next week into `.trellis/spec/` and links it from the index (including the after-a-bug analysis), `trellis-journal` appends a session entry, `trellis-plan` plans a task as `prd.md` / `design.md` / `implement.md` in `.trellis/tasks/MM-DD-slug/` (decisions through `grilling`) and archives it to `tasks/archive/YYYY-MM/` when done.
- **Path-scoped specs.** A spec with `paths:` globs in its frontmatter is appended to the result of a `read`, `edit`, `write`, or `apply_patch` of a matching file, so the rule is in context before the change. Each spec is attached once per session; it comes back only when the spec file changed, after compaction, or on another `/tree` branch. Budgets: 6000 characters per spec (longer ones are cut with a pointer to the file), 8000 per tool result, 40000 per session; past them a spec is listed by path and description.
- **The journal** is written by a small script the skill runs (`node trellis-lite/bin/trellis-lite.ts journal`), in Trellis's journal format: numbering continues, a full file (2000 lines, or `max_journal_lines`) rolls over to the next `journal-N.md`, and the developer's `index.md` tables are refreshed. Nothing is ever committed.

There is no per-turn injection, no tool, no task state, no subagent, and no Python. On a copy of a real Trellis project (16 specs, 34 journal sessions, no open task), the first request went from 15,070 tokens with Trellis 0.6.17 to 8,860 after migrating; trellis-lite's own share is about 630 tokens (section and three skill entries).

```
/trellis-lite            status: project root, the section as sent, path-scoped specs and frontmatter errors
/trellis-lite init       create what is missing: .trellis/spec/index.md, .developer, the first journal, .gitignore entry
/trellis-lite migrate    dry-run plan for leaving Trellis (read-only)
/trellis-lite-migrate    let the agent carry out the migration, asking before each change
```

**Switches.** `PI_PRESET_TRELLIS=off` turns it off; `PI_PRESET_TRELLIS_SPECS=off` keeps everything except path-scoped specs. It is also an ordinary extension of this package: untick `extensions/trellis-lite.ts` in `pi config`, or exclude it in a project's `.pi/settings.json` package filter.

**Coming from Trellis.** While the project still has Trellis's (or mini-trellis's) pi assets — `.pi/extensions/trellis/`, `.agents/skills/trellis-*`, `.pi/prompts/trellis-*` — trellis-lite stays idle and says so once per session. `/trellis-lite-migrate` hands the agent a procedure:

1. The CLI classifies every file Trellis installed, using Trellis's own `.trellis/.template-hashes.json`: unmodified templates and runtime leftovers (`.runtime/`, `.backup-*`, `__pycache__`) are deleted; `AGENTS.md`, `.pi/settings.json`, and the `.gitignore` files lose only their Trellis parts; spec, workspace, and tasks are never touched; files of other hosts (`.claude/`) stay unless you choose to remove them; modified or unregistered Trellis files are kept for review. It refuses to apply outside git or with uncommitted changes, so `git` is the undo.
2. The agent diffs each kept file against the original template of your Trellis version and moves what the project added: procedures (a release flow) into `.pi/prompts/<name>.md`, standing rules into `AGENTS.md`; Trellis mechanics are dropped. Every write waits for your confirmation.
3. It lists references to removed machinery in specs and `AGENTS.md`, suggests `paths:` for specs, and proposes a commit message. Nothing is committed without your approval.

**Following upstream.** trellis-lite follows Trellis (beta and stable) and mini-trellis for behavior and format changes, not code: `node scripts/check-upstream-trellis.mjs` lists what changed on the watched paths since the recorded baselines, and [`docs/trellis-lite-upstream.md`](docs/trellis-lite-upstream.md) holds the evaluation rules and the decision log. In this repository, `/trellis-lite-upstream` has the agent review the changes. Run it monthly or after an upstream release.

## Skills

`grill-me` and `grilling` ship in [`skills/`](skills), adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills) (MIT, see [`skills/NOTICE.md`](skills/NOTICE.md)). They are maintained here and not synced from upstream.

- `/skill:grill-me` starts a grilling session on a plan or idea; it is hidden from the model's skill list.
- `grilling` is the interview itself; the model also loads it on its own for "grill me"-style requests.

The pi version asks each round through `ask_user_question` (at most 4 questions per call, the recommended answer first) instead of a numbered text list, so answers are picked rather than typed. When a round has more open decisions than that, the 4 most fundamental go first and the rest follow in the next round. Facts are looked up by the model itself (or `agent_bg`), never asked.

## What it ships

| Resource | Effect |
|---|---|
| `extensions/vibrant-footer.ts` | The status bar. Toggle with `/vibrant-footer` |
| `extensions/pi-preset.ts` | The `/pi-preset` control panel: sync, the models.json template, and the font-install prompt in one TUI menu |
| `extensions/compact-tools.ts` | Caps collapsed `edit` rows (see [Tool rows](#tool-rows-extensionscompact-toolsts)). No command |
| `extensions/termius.ts` | Installs and registers the Termius MCP server, `/termius`, approval modes, and the local guard (see [SSH](#ssh-the-termius-mcp-server)) |
| `extensions/cache-retention.ts` | Defaults `PI_CACHE_RETENTION` to `long` inside pi (1h Anthropic cache TTL, 24h OpenAI Responses retention) so it applies even in shells that never sourced your rc file. An explicit value in the environment wins. No command, no UI |
| `extensions/idle-keepwarm.ts` | Keeps the Anthropic prompt cache warm while pi's UI stays open and idle, past pi's own 30-minute idle limit (see below). Status bar segment `keepwarm`, no command |
| `extensions/trellis-lite.ts` | Project memory for `.trellis/` projects: spec, journal, light task plans (see [trellis-lite](#project-memory-trellis-lite)). `/trellis-lite`, `/trellis-lite-migrate` |
| `extensions/inherit-model.ts` | `/new` keeps the model and thinking level you were just using instead of falling back to `defaultModel` (see below). No command, no UI |
| `vendor/` | The vendored extensions (see [Extensions](#extensions)) |
| `skills/` | `grill-me` and `grilling` (see [Skills](#skills)) |
| `trellis-lite/` | trellis-lite's skills (loaded only in Trellis projects), its CLI, the migration prompt, and upstream baselines |
| `templates/models.json`, `templates/settings.json` | The provider template (placeholder endpoints and keys) and its default provider/model |
| `scripts/upstream.mjs`, `scripts/migrate-vendored.ts` | Upstream tracking and the 0.1 → 0.2 migration |
| `scripts/check-upstream-trellis.mjs` | What changed in Trellis and mini-trellis since trellis-lite's baselines (read-only) |

### Reading the status bar

```
✧ ~/project · ⎇ main
▰▱▱▱▱▱ 58k/272k 21% · ↑ 48k ↓ 38k · ▤ 1.1M ↻ 90k ◎ 93% · ⧗ 47m ♨ 21:43 ×2      provider · π model · ◆ high
◈ $0.410 · ◷ 36m52s
⟲ · ⬡ 12 · ⧉ 2·14 cm ts · ☑ 1/3 · ▸ current task
```

Segments show icons only (`⬡` counts the package extensions that register tools or commands; a vendored package counts once). Set `PI_PRESET_FOOTER_LABELS=1` to bring back the word labels (`in`, `out`, `cache r`, `w`, `hit`, `ttl`, `warm`, `pkg`, `mcp`); they are then shown whenever the stats fit in two lines. The list below uses those label names.

- **Context**: the meter plus `used/window percent` of the current context. Its color turns warning above 70% and error above 90%.
- **in / out**: input and output tokens summed over the whole session, not the current context.
- **cache r / w / hit**: session totals of cache-read and cache-write tokens, and the latest turn's cache hit rate.
- **ttl / warm**: time left before the prompt-cache entry expires (warning-toned in the last 5 minutes), and when `idle-keepwarm` refreshes it next, with the number of refreshes since your last message. A dim note replaces both while warming is paused.
- **◈**: session cost as `$0.410` (`sub` when the model runs on an OAuth subscription), or `Σ` total tokens when the provider reports no price.
- **⟲**: [pi-workspace-history](https://www.npmjs.com/package/pi-workspace-history) is active (`/undo` works), shown as a success-toned glyph. The footer draws its `⟲ history` status itself; it turns into an error-toned `snapshot failed` when snapshots break (see `/history-status`). Hidden when the extension is not installed or `workspaceHistory.showStatus` is `false`.
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

1. **Removes superseded `packages[]` entries** — the packages the preset now vendors or replaced — in every mode, and **every other entry outside the preset that you did not check to keep** (see [Packages outside the preset](#packages-outside-the-preset)).
2. **Sets the config keys** below in `settings.json` and `mcp.json`.
3. **Moves a local `extensions/vibrant-footer/`** into `extensions-disabled/` if one exists, so the footer does not load twice.
4. **Warns** when upstream-installed `grill-me` / `grilling` copies still shadow the bundled skills (the migration script removes them).
5. **Makes pi's data private** (Linux/macOS): the agent directory to 0700 and `auth.json`, `models.json`, `mcp.json` and their backups to 0600, plus the Termius server's data directory (`.termius` in your home) to 0700. pi creates them with your umask, usually 0755/0644, and they hold API keys and full session transcripts. Only group/other bits are removed, only on paths you own; symlinks are skipped.

Every step is idempotent. A second run reports "already in sync" and touches nothing — not even file mtimes.

### Native compaction

The vendored `pi-better-compaction` replaces pi's text summary with the provider's own server-side compaction where the API offers one, and falls back to pi's compaction whenever that fails:

- **OpenAI Responses** (`openai-responses`): native `/responses/compact`. The result is an opaque window that replays only for the provider and model that produced it.
- **Anthropic Messages** (`anthropic-messages`): on-demand compaction (beta `compact-2026-09-04`, Claude Sonnet 4.6 / Opus 4.6 and newer, not Haiku). The signed block replays for the same model; its text also becomes pi's summary, so other models can still read it.
- Everything else keeps pi's compaction.

Whether native compaction actually runs depends on the relay. CLIProxyAPI (verified on 8.0.8) passes the beta through but adds `context_management` to every thinking request, which Anthropic refuses next to `compaction`. pi always sends thinking for the preset's Anthropic models, so before 0.7.3 every Anthropic compaction through CLIProxyAPI fell back to pi's. Since 0.7.3 the package retries that one rejected request without thinking ([lll9p/pi-better-compaction#9](https://github.com/lll9p/pi-better-compaction/pull/9); thinking blocks already in the history are kept, later turns keep your thinking level). The old `git:github.com/zidou-kiyn/pi-better-compaction` fork entry is superseded like the npm one, so the sync removes it.

**Switching models after an OpenAI native compaction.** The new model cannot read the opaque window and continues from the kept messages only. The package warns when this happens ([#10](https://github.com/lll9p/pi-better-compaction/pull/10)). To give the new model the full history, use `/tree` to branch from the entry just before that compaction; pi rebuilds the context from the original messages and compacts again with the new model if it does not fit. Switching away from an Anthropic compaction is safe.

To check what happened, run `/compact` and look at the session's compaction entry: `details.strategy` is `anthropic-native-compact-v1` or `openai-native-compact-v*` for native compaction, and absent for pi's own. For the reason behind a fallback, set `"debug": true` in `~/.pi/agent/extensions/pi-better-compaction/config.json`.

### Packages outside the preset

`packages[]` is managed as a **whitelist**. The sync checklist lists every installed entry that is neither required, optional, superseded, nor the preset itself, under *Packages not in the preset*, **unchecked**. Check the ones this machine should keep; everything left unchecked is removed. Unchecking an installed optional extension removes it the same way.

- **Nothing is written from the checklist.** The plan that follows lists each removal as a `- remove` line with its reason, and needs the usual confirmation.
- **The preset never removes itself**, whether it was installed as `git:github.com/zidou-kiyn/pi-preset` (any ref) or from a local path pointing at this package.
- **Removal goes through `pi remove <source>`**, so npm packages are uninstalled and git checkouts deleted exactly as pi would do it by hand. Its output is captured so it cannot print over the TUI. For a local-path entry only the `settings.json` entry is removed; the directory is left alone.
- **Matching is by package identity**: `npm:pi-btw@0.6.1` and `{ "source": "npm:pi-btw", ... }` are the same package, listed once and removed together.
- If `pi remove` fails, the entry is still removed from `settings.json` and the result says which files may remain.
- **RPC and print modes only remove superseded packages** (see [Migrating from 0.1](#migrating-from-01)): with no checklist there is no consent for anything else.

### The config keys

Written to `settings.json`, next to `packages[]`:

```json
{
  "tuiMode": "fullscreen",
  "fullscreenWheelScrollLines": "auto",
  "fullscreenCopyOnSelect": false,
  "enableInstallTelemetry": false
}
```

This turns on pi's fullscreen TUI. `"auto"` adapts wheel speed to the terminal (one line per event on local macOS, accelerated up to 6 elsewhere and over SSH). With copy-on-select off, selecting text no longer overwrites the clipboard; press `ctrl+x` (`app.message.copy`) to copy the active selection. `enableInstallTelemetry: false` stops pi's anonymous install/update reports and the provider attribution headers it adds to requests; update checks are separate and still run. Like any `settings.json` change made by the sync, it takes effect after a restart.

Written to `mcp.json` (see [Browser](#browser-the-chrome-devtools-mcp-server)):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.10.1", "--no-usage-statistics", "--no-performance-crux"],
      "env": { "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1" },
      "exposure": "codemode",
      "description": "Drive a Chrome browser: navigate, click, fill forms, evaluate JS, screenshots, console, network, performance traces"
    }
  }
}
```

Nothing else is written; other servers and keys in `mcp.json` stay. Writes to both files are a deep merge of exactly those leaf keys — never a whole-file overwrite. If a file does not parse as JSON, only that step aborts, rather than starting from `{}` and erasing your hand-tuned settings. The previous content is copied to `<file>.preset-bak` before every write, and the write itself is a tmp-file rename so an interrupted run cannot truncate it.

0.1 also wrote `extensions/pi-tool-display/config.json` and `keybindings.json` (`tui.editor.cursorLeft: ["left"]`, to free ctrl+b for patty 1.x). Neither is needed any more; the keybinding is left as it is.

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

- **Vendored, not depended on.** Every extension is a reviewed copy in this repository, so an upstream release cannot change behavior until it is pulled, local fixes need no fork per package, and updating the one package updates everything. The cost is following upstream by hand; `npm run upstream -- status` shows what is pending.
- **Few personal preferences are shipped.** The sync flow sets only the fullscreen TUI keys and the chrome-devtools MCP server besides `packages[]`. `defaultProvider` and `defaultModel` are written only when you apply the models.json template, and you pick them there. No `theme`, no `defaultThinkingLevel`, no `AGENTS.md`.
- **No credentials, ever.** The models template holds only placeholder endpoints and `$ENV_VAR` keys. `scripts/scan-secrets.sh` scans the working tree and the full git history before every push. Personal identifiers to block (user name, relay hosts, local ports) are kept out of the repository too: put one regular expression per line in `~/.config/pi-preset/scan-private-patterns` (or point `PI_PRESET_SCAN_PRIVATE` at a file). Reviewed false positives in vendored code are allowlisted by line hash in `scripts/scan-secrets-allow.json`.
- **`packages[]` changes need a restart.** Extensions get no access to pi's settings manager, so the sync writes the file while the running session still holds the array it loaded at startup. If you use `/config` or `pi install` in that same session afterwards, pi persists its stale snapshot and removed entries come back. Re-running the sync fixes it; nothing else is lost.
- **MCP goes through codemode.** The preset adds two servers, chrome-devtools (in `mcp.json`) and Termius (registered by its extension), both with codemode exposure, so their tools are called from scripts instead of being declared. Other servers carry credentials and differ per person, so they are left to `/mcp`. The footer shows what is connected.
- **Runtime dependencies are the vendored packages' own:** `@ff-labs/fff-node` / `fff-bun` (fff's native search library), `ignore` (workspace-history), `diff` (apply-patch), and the vendored `rpiv-config` through a `file:` dependency. pi installs them with the package. The Termius server's Python dependencies (paramiko, pynacl, cryptography, keyring, …) live in its own environment, created by `/termius setup`.
- **trellis-lite is written here, not vendored.** Trellis and mini-trellis are AGPL-3.0; this repository is MIT. trellis-lite is a clean-room implementation: upstream is read for behavior and file formats only, changes are described in our own words in the design doc or decision log, then implemented. Its skills are not in `package.json` `pi.skills`, because a package skill is visible in every project; the extension offers them per project.
- **`pi-startup-redraw-fix` is not included.** It rewrites `ESC[3J ESC[2J ESC[H` into `ESC[H ESC[2J ESC[3J`, but pi's alternate-screen renderer emits `ESC[2J ESC[H ESC[3J`, which never matches its trigger. The patch cannot fire.

## Development

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

## License

MIT for this repository. Vendored code keeps its upstream license in its own directory (MIT, BSD 3-clause for termius-mcp); the skills' notice is in `skills/NOTICE.md`.
