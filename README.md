# pi-preset

My [pi](https://pi.dev) environment as one pi package: a status bar, the extensions I work with (vendored and maintained here), two MCP servers, project memory for `.trellis/` projects, two skills, and a `models.json` template for OpenAI / Anthropic / DeepSeek relays.

It sets up a new machine in two commands and ships no credentials. Updating this one package updates everything in it.

## Install

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi and run `/pi-preset`, the control panel:

1. **Sync preset**: config keys, the chrome-devtools MCP server, and `packages[]` cleanup. It shows a diff and writes nothing until you confirm. Restart pi afterwards.
2. **Apply models.json template**: providers, models, and the default model. See [docs/models.md](docs/models.md).
3. **Install the Maple Mono NF CN font (ask pi)**: the status bar needs a Nerd Font.

For SSH through your Termius hosts, open `/termius` once: it installs the server, then sign in from the same menu.

To update, run `pi update git:github.com/zidou-kiyn/pi-preset` (plain `pi update` updates only pi itself). Then restart pi or run `/reload`.

Details: [docs/setup.md](docs/setup.md) covers what the sync writes, the package whitelist, git refs, migrating from 0.1, and the font.

## What you get

| Area | What | Use | Docs |
|---|---|---|---|
| Shell | Long commands move to the background; you get one notification when they finish | `bash run_in_background`, `jobs`, `monitor`, `agent_bg`, ctrl+shift+b | [extensions](docs/extensions.md#background-commands-pi-patty-bg-tasks) |
| Search | Frecency-ranked, git-aware grep and file find | `ffgrep`, `fffind` | [extensions](docs/extensions.md) |
| Undo | File snapshots per turn; rewind the last prompt | `/undo`, `/redo`, `/diff`, `/checkpoint`, `/fuck` | [extensions](docs/extensions.md) |
| Planning | Task list; structured questions | `todo`, `ask_user_question` | [extensions](docs/extensions.md) |
| Web | Search through the current provider, no extra key | `web_search` | [extensions](docs/extensions.md) |
| Context | Native provider compaction; context breakdown; compact `edit` rows | `/compact`, `/context` | [extensions](docs/extensions.md#native-compaction) |
| Cache | 1h prompt cache, kept warm while idle | automatic | [extensions](docs/extensions.md#prompt-cache-kept-warm-while-idle) |
| Models | `/new` keeps the current model; Codex `apply_patch` for OpenAI | automatic | [extensions](docs/extensions.md) |
| Status bar | Context, tokens, cache, cost, TTL, MCP | `/vibrant-footer` | [extensions](docs/extensions.md#reading-the-status-bar) |
| Browser | chrome-devtools MCP, called from codemode | automatic after sync | [mcp](docs/mcp.md) |
| SSH | Termius hosts: exec and SFTP, secrets never shown to the model, approval modes | `/termius` | [mcp](docs/mcp.md#ssh-the-termius-mcp-server) |
| Project memory | Specs, journal, and task plans in `.trellis/`, with path-scoped specs | `/trellis-lite`, `/trellis-lite-migrate` | [trellis-lite](docs/trellis-lite.md) |
| Skills | Grill a plan until every decision is settled | `/skill:grill-me` | [below](#skills) |

## Skills

`grill-me` and `grilling` are adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills) (MIT, see [`skills/NOTICE.md`](skills/NOTICE.md)):

- `/skill:grill-me` starts a session. It is hidden from the model's skill list.
- The model also loads `grilling` on its own for "grill me"-style requests.

Each round goes through `ask_user_question` with the recommended answer first. The model looks up facts itself and asks you only for decisions.

## Switches

| Variable | Default | Effect |
|---|---|---|
| `PI_CACHE_RETENTION` | `long` (set by the preset) | Prompt cache lifetime: 1h Anthropic, 24h OpenAI |
| `PI_PRESET_KEEPWARM` | on | `off` stops idle cache warming |
| `PI_PRESET_KEEPWARM_MAX_IDLE` | no limit | Stop warming after this long without a request, e.g. `3h` |
| `PI_PRESET_BASH_BG_DEFAULT` / `_CAP` | `30` / `60` seconds | When a foreground command moves to the background; `off` restores upstream timing |
| `PI_PRESET_EDIT_LINES` | `16` | Lines in a collapsed `edit` row; `off` shows the full diff |
| `PI_PRESET_FOOTER_LABELS` | off | `1` shows word labels in the status bar |
| `PI_PRESET_TRELLIS` / `_SPECS` | on | `off` disables trellis-lite, or only its path-scoped specs |

Any bundled extension can also be unticked in `pi config`.

## Development

```bash
npm install && npm test        # npm run test:termius for the Python server
npm run release -- minor       # then: git push --follow-tags
```

In this repository, `/preset-upstream` reviews upstream changes to everything vendored and decides what to carry over.

See [docs/development.md](docs/development.md) for testing a local checkout, versions, following upstream, design notes, and the repository layout.

## License

MIT. Vendored code keeps its upstream license in its own directory (MIT; BSD 3-clause for termius-mcp). The skills' notice is in `skills/NOTICE.md`.
