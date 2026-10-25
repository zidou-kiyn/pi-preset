# Setup and sync

What `/pi-preset` does, how the preset manages `packages[]` and config, and how to move from 0.1.

## The control panel

`/pi-preset` is the preset's single visual control panel — a TUI menu with three entries:

1. **Sync preset** — config keys, the chrome-devtools MCP server, and `packages[]` cleanup. Starts with a checklist of installed packages that are not part of the preset (unchecked, i.e. removed, by default), then shows a diff of everything it would change and writes nothing until you confirm.
2. **Apply models.json template** — replaces `~/.pi/agent/models.json` with the preset's providers and sets the default provider and model (see [models.json template](models.md)).
3. **Install the Maple Mono NF CN font (ask pi)** — sends a font-install prompt to the current model (see [Font](#font)).

After a sync that removed packages, restart pi — and do that before touching `/config` in the same session (see [Design notes](development.md#design-notes)).

For SSH through your Termius hosts, run `/termius setup` and `/termius login` once (see [SSH](mcp.md#ssh-the-termius-mcp-server)).

## What Sync preset does

1. **Removes superseded `packages[]` entries** — the packages the preset now vendors or replaced — in every mode, and **every other entry outside the preset that you did not check to keep** (see [Packages outside the preset](#packages-outside-the-preset)).
2. **Sets the config keys** below in `settings.json` and `mcp.json`.
3. **Moves a local `extensions/vibrant-footer/`** into `extensions-disabled/` if one exists, so the footer does not load twice.
4. **Warns** when upstream-installed `grill-me` / `grilling` copies still shadow the bundled skills (the migration script removes them).
5. **Makes pi's data private** (Linux/macOS): the agent directory to 0700 and `auth.json`, `models.json`, `mcp.json` and their backups to 0600, plus the Termius server's data directory (`.termius` in your home) to 0700. pi creates them with your umask, usually 0755/0644, and they hold API keys and full session transcripts. Only group/other bits are removed, only on paths you own; symlinks are skipped.

Every step is idempotent. A second run reports "already in sync" and touches nothing — not even file mtimes.

## Packages outside the preset

`packages[]` is managed as a **whitelist**. The sync checklist lists every installed entry that is neither required, optional, superseded, nor the preset itself, under *Packages not in the preset*, **unchecked**. Check the ones this machine should keep; everything left unchecked is removed. Unchecking an installed optional extension removes it the same way.

- **Nothing is written from the checklist.** The plan that follows lists each removal as a `- remove` line with its reason, and needs the usual confirmation.
- **The preset never removes itself**, whether it was installed as `git:github.com/zidou-kiyn/pi-preset` (any ref) or from a local path pointing at this package.
- **Removal goes through `pi remove <source>`**, so npm packages are uninstalled and git checkouts deleted exactly as pi would do it by hand. Its output is captured so it cannot print over the TUI. For a local-path entry only the `settings.json` entry is removed; the directory is left alone.
- **Matching is by package identity**: `npm:pi-btw@0.6.1` and `{ "source": "npm:pi-btw", ... }` are the same package, listed once and removed together.
- If `pi remove` fails, the entry is still removed from `settings.json` and the result says which files may remain.
- **RPC and print modes only remove superseded packages** (see [Migrating from 0.1](#migrating-from-01)): with no checklist there is no consent for anything else.

## The config keys

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

Written to `mcp.json` (see [Browser](mcp.md#browser-the-chrome-devtools-mcp-server)):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.12.0", "--no-usage-statistics", "--no-performance-crux"],
      "env": { "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1" },
      "exposure": "codemode",
      "description": "Drive a Chrome browser: navigate, click, fill forms, evaluate JS, screenshots, console, network, performance traces"
    }
  }
}
```

Nothing else is written; other servers and keys in `mcp.json` stay. Writes to both files are a deep merge of exactly those leaf keys — never a whole-file overwrite. If a file does not parse as JSON, only that step aborts, rather than starting from `{}` and erasing your hand-tuned settings. The previous content is copied to `<file>.preset-bak` before every write, and the write itself is a tmp-file rename so an interrupted run cannot truncate it.

0.1 also wrote `extensions/pi-tool-display/config.json` and `keybindings.json` (`tui.editor.cursorLeft: ["left"]`, to free ctrl+b for patty 1.x). Neither is needed any more; the keybinding is left as it is.

## Git ref semantics

The `packages[]` entry for this package deliberately carries **no `@ref`**:

```
git:github.com/zidou-kiyn/pi-preset
```

pi only reconciles a git source to its *configured* ref and never advances it on its own. Omitting the ref means the clone follows the default branch, so `pi update --extensions` picks up new commits. Pinning a tag here would mean every change required editing `settings.json` on every machine.

## Migrating from 0.1

0.1 installed every extension as its own `packages[]` entry; 0.2 loads them from this package. pi refuses to start when two extensions register the same tool name, so on every machine the old entries must go **after** the preset is updated and **before** pi starts again. Close every pi session first, then:

```bash
pi update git:github.com/zidou-kiyn/pi-preset    # only the preset; plain `pi update` updates pi itself
cd ~/.pi/agent/git/github.com/zidou-kiyn/pi-preset   # Windows: cd $HOME\.pi\agent\git\github.com\zidou-kiyn\pi-preset
node scripts/migrate-vendored.ts                 # dry run: lists what it would change
node scripts/migrate-vendored.ts --apply         # then do it
```

The script needs nothing beyond the Node.js pi already requires. It removes the superseded `packages[]` entries, moves the upstream-installed `grill-me` / `grilling` copies out of `~/.agents/skills` (they would shadow the bundled ones) and drops them from the skills lock file, and moves the leftover `extensions/pi-tool-display` and `extensions/pi-permission-system` data directories. Nothing is deleted: everything goes to `~/.pi/agent/preset-migration-backup/<timestamp>/`. Then start pi, run **Sync preset** in `/pi-preset` once (MCP config, remaining cleanup), and restart pi. Later syncs also remove any superseded entry that comes back.

If pi was started in between and stopped with `Tool "…" conflicts with …`, just run the script and start again.

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

You can also paste it yourself. The text lives in [`src/font-prompt.ts`](../src/font-prompt.ts). Afterwards, restart the terminal or open a new window if the model says so.
