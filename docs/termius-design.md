# Termius: host policies, routes, and the /termius UI — design

> Status: decisions agreed with the user on 2026-10-29 (grilling session); implemented. User-facing behavior is described in [mcp.md](mcp.md#ssh-the-termius-mcp-server).
> Scope: per-host access levels and routes for the Termius MCP server, a reworked `/termius` menu, an activity log, a footer segment, and bilingual (en/zh) UI text for the whole preset.

## 1. Findings that shaped the design

- **The proxy setting never overrides a jump host chain.** `/termius proxy` (system / URL / direct) applies only to hosts without a Termius host chain. A chained host always goes through its chain, and the first hop is always dialed directly, even when a proxy is set. "Direct" therefore does not mean "ignore the chain", and a network that needs the proxy to reach the jump host is not supported.
- **"Allow everything on this host for this session" is keyed by the `name` string** the agent passed, so the same host called by id and by label counts as two hosts. The set lives in memory and is lost on `/reload`.
- **The preset menu has no scrolling or filtering**; number keys cover items 1–9.
- **The vault this was designed with**: about a dozen hosts, no groups, not a team account; most hosts sit behind one of a few jump hosts (chains of up to two hops). Per-host routes matter more than group rules.
- **pi has no i18n.** Its own UI (`/settings`, `/model`, …) stays English. Vendored packages are upstream copies; translating them would conflict on every upstream pull.
- **Footer**: `ctx.ui.setStatus` texts are drawn by `vibrant-footer` on an extra line, joined and truncated. `idle-keepwarm` instead publishes a snapshot that the footer draws as a compact icon segment in the stats line.
- **Tags are synced** (`TagHost` is part of the bulk pull), so they can be displayed and filtered on.

## 2. Decisions

### 2.1 Access levels

- One **access level** per host: `inherit` (follow global) / `off` (disabled) / `read-only` / `review` / `auto` / `trusted`. The global level uses the same names minus `off` (the global "off" is the existing "turn the MCP server off").
- `dangerously` is renamed `trusted`; `/termius mode dangerously` keeps working as an alias. Behavior change: `trusted` now asks for catastrophic commands (2.3).
- **read-only**: reads run without asking; writes are refused without a dialog, and the refusal tells the agent the host is read-only and to ask the user.
- **off**: the host is left out of `hosts` (which reports "N more hosts hidden by the user"); `exec` / `files` / `host` naming it fail with `host_disabled` and a hint to enable it in `/termius`. A disabled host still works as a **jump host** for other hosts; the menu notes "jump host for N".
- **Granularity**: per host only (no group or tag inheritance); the host list supports multi-select for batch edits.
- **New hosts** (synced later) follow the global level and carry a "new" mark until the user sets their level (choosing "inherit" explicitly also clears it). On first run, every existing host is the baseline and is not marked.
- **Storage**: this machine only, in the server's `config.json`, keyed by the Termius **cloud id** (survives renames; a different account's hosts never match).

### 2.2 Approval dialog

- Items: Allow once / Allow this host for this session / Always trust this host (saves `trusted`) / Deny / Deny and disable this host (saves `off`) / Deny and tell the agent why (typed reason, sent as the block reason).
- Header: host, address, the route this call takes, the effective level, and why it asks (e.g. "write: output redirection `>`", or a red "catastrophic").
- Session allows are keyed by host **cloud id** (fixes the id-vs-label bug).
- **Session scope**: survives `/reload`; cleared by `/new`, switching sessions, and restarting pi; not restored when `/resume` returns to the session later. Stored as a custom session entry, read back only on `session_start` with reason `reload`.
- **Temporary level for this session**: set in the host detail page (any level), reverted when the session ends; this is how a read-only host is opened for a one-off change. Session allows are per host only (no per-program or all-hosts allow).

### 2.3 Catastrophic commands

A fixed list asks at every level (red "catastrophic" in the dialog), including `trusted` and session-allowed hosts; on a read-only host it is refused. The list covers: `rm -r` on `/` or system directories, `mkfs*`, `dd of=/dev/…`, `wipefs`, partitioning tools that write, `reboot` / `shutdown` / `poweroff` / `halt` / `init 0|6`, flushing firewall rules (`iptables -F`, `nft flush ruleset`, `ufw reset|disable`), stopping / disabling / masking `sshd`, `userdel` / `deluser`, recursive `chmod` / `chown` on `/`, `kill -9 1`, fork bombs. `files rm` with `recursive` on `/` or a system directory counts too.

### 2.4 Routes

- Four route modes, the same set globally and per host (hosts add **inherit**):
  1. `termius`: the host's Termius chain, first hop dialed directly; a host without a chain uses the proxy setting (with its bypass list);
  2. `termius-proxy`: the chain with the **first hop through the proxy**; a host without a chain uses the proxy setting;
  3. `direct`: no chain, no proxy;
  4. `proxy`: no chain, through the proxy (the global proxy, or a URL set on this host).
- The global mode plus per-host overrides is how the user switches environments: change the global mode once, override the exceptions.
- **Deterministic**: a route that fails is an error; there is no fallback to another route. A route that needs a proxy when none is configured (no system variables, no URL) is an error, never a silent direct connection.
- The **proxy** setting keeps meaning only "which proxy" (system variables or a URL); whether a host uses it is the route's job.

### 2.5 The /termius menu

- **Signed out** (installed): status "signed out · MCP on/off"; items: Sign in, Recent activity (only when the log is not empty), Turn the MCP server on/off. **Not installed**: Install, on/off (as today).
- **Signed in**: status lines (account · host count · last sync; MCP · global level · global route); items: Hosts (hint: count · new · session-allowed), Global access level, Global route, Proxy, Recent activity, Sign out, Turn the MCP server off.
- **Hosts**: flat list sorted by label. Columns: label, address, effective route, level; marks for new, session-allowed, temporary level, and "jump host for N". Typing filters (label, address, tags), Space toggles selection, Enter opens the detail page (or the batch editor with a selection).
- **Detail page**: address, port, user, tags, chain, effective route, level, ssh command; actions: level, route (+ host proxy URL), temporary level for this session, revoke the session allow, **test connection** (connects hop by hop, authenticates, runs nothing; shows each hop's result and time).
- **Recent activity**: every remote call with time, host, route, command or file action, decision (auto / approved / denied / refused / catastrophic), exit code. No output. A "clear" action.
- **Sign-out** keeps per-host settings and the activity log.

### 2.6 Visibility

- **Footer**: a compact icon segment in the stats line, like keepwarm. At rest it shows only when the global route is not `termius` or a temporary level / session allow exists (e.g. `direct +2`); while a call connects it shows the host label. Narrow terminals keep the icon and the number. Shown in pi's default footer through `setStatus` for users without vibrant-footer.
- **Agent view**: `hosts` / `host` carry each host's effective level (including temporary levels and session allows) and route; tool descriptions say that read-only hosts refuse writes.

### 2.7 Language (whole preset)

- Bilingual UI (en / zh) for the preset's own extensions; vendored packages and pi itself are untouched.
- Language: `PI_PRESET_LANG` (en | zh), else the choice saved from `/pi-preset` (auto / 中文 / English), else the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`, then `Intl`).
- One **typed catalog per feature** (`const zh: typeof en`), parameterized messages as functions; a missing or mismatched entry fails type checking and a parity test. A small `src/i18n.ts` picks the language.
- Text for the model (tool descriptions, block reasons, errors, injected notes) stays English.

### 2.8 Defaults chosen during implementation

- Enforcement: the server enforces `off` and routes, re-reading the policy file on every call (mtime-cached), so changes apply at once; the extension's gate checks again. The menu's host list and the connection test come from two new `login-json` actions that return no secrets.
- Activity log: `activity.jsonl` in the server's install directory (already off limits to agent tools), mode 0600, newest 500 entries, vault secrets redacted from commands.
- Typed subcommands: `/termius host <name> <level>`, `/termius route <mode>` besides the menu.
- `extensions/termius.ts` is split by responsibility into `src/termius/`.

## 3. Architecture

### 3.1 config.json (version 2)

```jsonc
{
  "mode": "auto",                 // global level: read-only | review | auto | trusted
  "route": "termius",             // termius | termius-proxy | direct | proxy (absent = termius)
  "proxy": "socks5://…",          // absent = system variables; "off" = none
  "proxyBypass": ["…"],
  "enabled": false,               // absent = on
  "hosts": {                      // keyed by cloud id
    "12345": { "label": "api-prod", "level": "read-only", "route": "direct", "proxy": "socks5://…" }
  },
  "knownHosts": ["12345", "…"]   // baseline for the "new" mark
}
```

`mode: "dangerously"` is read as `trusted` and rewritten on the next save. `label` is a display snapshot only.

### 3.2 Server (vendor/termius-mcp)

- `TERMIUS_MCP_POLICY` = path of `config.json`; `termius/policy.py` reads it (mtime cache): disabled cloud ids, global route, per-host route and proxy URL.
- `hosts` drops disabled hosts and reports `hidden`; `host` / `exec` / `files` on a disabled host raise `host_disabled`.
- Route resolution in `connect_host`: the four modes, first-hop proxy, per-host proxy URL, errors instead of fallbacks. Results carry `route`.
- Host rows carry `cloud_id`, tags, and the resolved route.
- `login-json` actions: `hosts` (menu rows: ids, label, address, port, user, tags, chain, route) and `test` (hop-by-hop connect and auth, per-hop timing).

### 3.3 Extension modules (src/termius/)

| Module | Responsibility |
|---|---|
| `config.ts` | config v2 read / write / migration; route modes |
| `levels.ts` | levels, effective level (temporary > host > global), decisions incl. read-only and catastrophic |
| `approval.ts` | command classification (existing) + catastrophic rules |
| `session-state.ts` | session allows and temporary levels; custom entry, restored on reload |
| `host-index.ts` | cached host rows from `login-json hosts`; name → cloud id |
| `gate.ts` | `tool_call` gate and the approval dialog; `tool_result` annotation of `hosts` / `host` |
| `activity.ts` | activity log |
| `footer-state.ts` | footer snapshot |
| `hosts-menu.ts`, `host-list.ts`, `activity-view.ts` | the host list (filter, multi-select, scrolling), detail page, batch editor, activity view; the main menu stays in `extensions/termius.ts` |
| `format.ts` | shared display helpers (relative times, route summaries) |
| `messages.ts` | en / zh catalog |

## 4. Implementation order (done)

1. i18n core (`src/i18n.ts`, language setting, parity test).
2. Server: policy file, route modes, disabled hosts, `login-json hosts` / `test`, Python tests.
3. Extension core: config v2, levels, session state, host index, catastrophic rules.
4. Gate and approval dialog; `tool_result` annotation.
5. Menus: state-dependent main menu, host list, detail page, batch edit, global level / route, subcommands.
6. Activity log and its view.
7. Footer snapshot and segment.
8. Bilingual UI for the other preset extensions; language item in `/pi-preset`.
9. Docs (`docs/mcp.md`, `docs/extensions.md`), full test run.
