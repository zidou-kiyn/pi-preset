# pi-preset

My [pi](https://pi.dev) environment as one pi package: a status bar, the extensions I work with (vendored and maintained here), two MCP servers, project memory for `.trellis/` projects, a store of on-demand skills, and a `models.json` template for OpenAI / Anthropic / DeepSeek relays.

It sets up a new machine in two commands and ships no credentials. Updating this one package updates everything in it.

## Install

```bash
pi install git:github.com/zidou-kiyn/pi-preset
```

Restart pi and run `/pi-preset`, the control panel:

1. **Sync preset**: config keys, the chrome-devtools MCP server, and `packages[]` cleanup. It shows a diff and writes nothing until you confirm. Restart pi afterwards.
2. **Apply models.json template**: providers, models, and the default model. See [docs/models.md](docs/models.md).
3. **Install the Maple Mono Normal NF CN font (ask pi)**: the status bar needs a Nerd Font.
4. **Language**: the preset's own menus and messages in English or Chinese (see [Language](#language)).

For SSH through your Termius hosts, open `/termius` once: it installs the server, then sign in from the same menu.

To update, run `pi update git:github.com/zidou-kiyn/pi-preset` (plain `pi update` updates only pi itself). Then restart pi or run `/reload`.

Details: [docs/setup.md](docs/setup.md) covers what the sync writes, the package whitelist, git refs, migrating from 0.1, and the font.

## What you get

| Area | What | Use | Docs |
|---|---|---|---|
| Shell | Long commands move to the background; you get one notification when they finish | `bash run_in_background`, `jobs`, `monitor`, `agent_bg`, ctrl+shift+b | [extensions](docs/extensions.md#background-commands-pi-patty-bg-tasks) |
| Search | Frecency-ranked, git-aware grep and file find | `ffgrep`, `fffind` | [extensions](docs/extensions.md) |
| Undo | File snapshots per turn; rewind the last prompt | `/undo`, `/redo`, `/diff`, `/checkpoint`, `/fuck` | [extensions](docs/extensions.md) |
| Planning | Task list (with a reminder when a task is left in_progress); structured questions | `todo`, `ask_user_question` | [extensions](docs/extensions.md#todo-nudges-extensionstodo-nudgets) |
| Web | Search through the current provider, no extra key | `web_search` | [extensions](docs/extensions.md) |
| Context | Native provider compaction; context breakdown; compact `edit` rows | `/compact`, `/context` | [extensions](docs/extensions.md#native-compaction) |
| Cache | 1h prompt cache, kept warm while idle | automatic | [extensions](docs/extensions.md#prompt-cache-kept-warm-while-idle) |
| Models | `/new` keeps the current model; Codex `apply_patch` for OpenAI | automatic | [extensions](docs/extensions.md) |
| Status bar | Context, tokens, cache, cost, TTL, MCP | `/vibrant-footer` | [extensions](docs/extensions.md#reading-the-status-bar) |
| Browser | chrome-devtools MCP, called from codemode | automatic after sync | [mcp](docs/mcp.md) |
| SSH | Termius hosts: exec and SFTP, secrets never shown to the model, per-host access levels and routes, activity log | `/termius` | [mcp](docs/mcp.md#ssh-the-termius-mcp-server) |
| Project memory | Specs, journal, and task plans in `.trellis/`, with path-scoped specs | `/trellis-lite`, `/trellis-lite-migrate` | [trellis-lite](docs/trellis-lite.md) |
| Skills | A store of skills loaded only when enabled (session / project / always): house rules for git and skill writing, grill a plan, hand a session off; install from GitHub, search skills.sh, let the model find and use them | `/skills`, `skills` tool | [below](#skills), [skills-store](docs/skills-store.md) |

## Skills

Skills you need now and then do not belong in `~/.pi/agent/skills`, where pi loads them into every session. `/skills` keeps them in a store and enables one for the session, for this directory, or always; "use now" sends it into the conversation without a reload. The model has the same store as the `skills` tool: ask it to find a skill for a task and it searches, installs after you confirm, and loads it. See [docs/skills-store.md](docs/skills-store.md).

The store is shown in groups: the bundled groups, then each repository you installed from, then hand-made skills. A group row enables, updates, or removes all of its skills at once. Bundled:

- **pi-preset**: `skill-authoring` and `git-conventions`, **on by default** (skill vs prompt template and how to write one; commit, branch, PR, issue, and release rules so every session does git the same way); `grill-me` and `handoff`, adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills) (MIT, see [`skills-store/pi-preset/NOTICE.md`](skills-store/pi-preset/NOTICE.md)). `/skills use grill-me <plan>` starts an interview that goes round by round through `ask_user_question`, recommended answer first; the model looks up facts itself and asks you only for decisions. `/skills use handoff [what the next session is for]` writes a handoff document to the temp directory: run `/new`, then ask the new session to read the file it named.
- **humanizer**: [humanizer-zh](https://github.com/op7418/Humanizer-zh) and [humanizer](https://github.com/blader/humanizer) (MIT), which take the AI tells out of Chinese and English text.
- **anthropics**: `frontend-design`, `mcp-builder`, `skill-creator`, `webapp-testing` from [anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0).

The vendored groups are tracked like the extensions (`vendor/UPSTREAM.json`, `npm run upstream -- status`). Anthropic's document skills (docx, xlsx, pptx, pdf) are under a proprietary license, so they stay on the recommended list and are fetched when you pick them.

## Language

The preset's own menus, dialogs, and messages (`/pi-preset`, `/termius`, `/trellis-lite`, the status bar's words) come in English and Chinese. By default they follow the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`); **Language** in `/pi-preset` (or `/pi-preset language auto|en|zh`) picks one for good, saved in `~/.pi/agent/pi-preset/settings.json`, and `PI_PRESET_LANG=en|zh` overrides both. pi's own UI and the vendored extensions stay English, and so does everything the model reads (tool descriptions, prompts, block reasons), so switching the language never changes what the agent sees.

## Switches

| Variable | Default | Effect |
|---|---|---|
| `PI_CACHE_RETENTION` | `long` (set by the preset) | Prompt cache lifetime: 1h Anthropic, 24h OpenAI |
| `PI_PRESET_KEEPWARM` | on | `off` stops idle cache warming |
| `PI_PRESET_KEEPWARM_MAX_IDLE` | no limit | Stop warming after this long without a request, e.g. `3h` |
| `PI_PRESET_BASH_BG_DEFAULT` / `_CAP` | `30` / `60` seconds | When a foreground command moves to the background; `off` restores upstream timing |
| `PI_PRESET_BG_CHECK` | `300` seconds | When a background job with no `expected_seconds` first checks in with the agent; `off` disables check-ins |
| `PI_PRESET_EDIT_LINES` | `16` | Lines in a collapsed `edit` row; `off` shows the full diff |
| `PI_PRESET_FOOTER_LABELS` | off | `1` shows word labels in the status bar |
| `PI_PRESET_LANG` | system locale | `en` or `zh` for the preset's own UI, over the `/pi-preset` choice |
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

MIT. Vendored code keeps its upstream license in its own directory (MIT; BSD 3-clause for termius-mcp). The adapted skills' notice is in `skills-store/pi-preset/NOTICE.md`; vendored store skills keep their license in their own directory (MIT, Apache-2.0).
