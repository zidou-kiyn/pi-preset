# MCP servers

## Codemode exposure

Both MCP servers below use `exposure: "codemode"`: none of their tools is declared to the model. The model calls them from a `codemode` script (`tools.mcp__chrome_devtools__navigate_page(...)`, `tools.mcp__termius__exec(...)`), finds signatures with `describeNamespace()` / `describeTool()`, and returns only what it needs, so a script can chain several calls and filter large output (page snapshots, logs from many hosts) before anything reaches the context. The tool declarations never change mid-session, and the only standing cost is the one `codemode` tool.

## Browser: the chrome-devtools MCP server

Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) runs through pi's built-in MCP support instead of a browser extension. **Sync preset** adds it to `~/.pi/agent/mcp.json`, pinned (`chrome-devtools-mcp@1.12.0`, via `npx`), with telemetry, CrUX lookups, and update checks off, and codemode exposure (its 32 tools are called from scripts). On the first browser call it starts its own Chrome with a separate profile. pi announces the session's working directory as the MCP root, so tools that read or write local files (screenshots saved to a path, `upload_file`) stay inside that directory and the temp directory. Turn it off in `/mcp`; the sync does not own `enabled`. Bump the version in `src/manifest.ts` after reading its changelog.

## SSH: the Termius MCP server

[`vendor/termius-mcp`](../vendor/termius-mcp) is [MiaM1ku/termius-mcp](https://github.com/MiaM1ku/termius-mcp) (Python, BSD, a fork of the official Termius CLI), hardened here, and [`extensions/termius.ts`](../extensions/termius.ts) installs and registers it. The agent can list your Termius hosts and run commands or move files on them over SSH with the hosts' own usernames, passwords, and keys, without ever seeing those secrets. You decide per host whether the agent may touch it at all, what it may do without asking, and how it is reached. The design and the decisions behind it are in [termius-design.md](termius-design.md).

### The /termius menu

`/termius` opens one menu. The top shows the live state and fills in as it arrives; below are only the actions that apply:

- **Not installed:** *Install the MCP server* and on/off. The first `/termius` installs it on its own (it only asks when uv has to be installed first).
- **Signed out:** *Sign in*, *Recent activity* (when there is any), on/off.
- **Signed in:** a status line with the account, host count, last sync, and whether the server is on (the global level and route show next to their items); items **Hosts**, **Global access level**, **Global route**, **Proxy**, **Recent activity**, **Sign out**, on/off.

↑↓ wrap around, number keys pick, a list taller than half the screen scrolls, Esc goes back one level; after an action the menu returns with its result on top. There is no sync item: the server keeps the host list fresh on its own (see Sync below), and `/termius sync` still forces a pull. Menus and dialogs follow the preset's UI language (English or Chinese, see [Language](../README.md#language)); what the model reads stays English.

**Hosts** lists every host, one row each: label, address, route (`→bastion` through a jump host, `⇢bastion` with the first hop through the proxy, `direct`, `proxy`), and the host's own level (`·` = follows the global level). Marks show what is special: `new` (synced since you last set levels), `temp: …` (a temporary level), `this session` (allowed for this session), `jump ×n` (n hosts reach their target through it). Typing filters on label, address, tags, route, and level; Space selects several hosts, and Enter then opens a batch editor for their level, route, temporary level, or session allows. Enter on one host opens its page: address, port, user, tags, the route in full (or why it cannot be used), the effective level and where it comes from, and the actions **Access level**, **Route**, **Proxy URL for this host** (when its route uses a proxy), **Temporary level for this session**, **Revoke this session's allow**, and **Test connection**, which connects along the route one hop at a time, signs in, runs nothing, and shows each hop with its time (or the hop that failed).

**Recent activity** pages through the log of remote calls: time, host, who let it run (`auto`, `approved`, `session`, `denied`, `refused`), exit code or error, route, and the command or file action. The output is never logged. The newest 500 calls are kept in `activity.jsonl` next to the server's `config.json` (mode 0600, off limits to agent tools); sign-out keeps it, and the view can clear it.

Typed subcommands skip the menu:

```
/termius login            sign in: email + password, or Google; asks for the 2FA code / app approval when Termius wants one
/termius logout           sign out and wipe the local host cache (host settings and the activity log stay)
/termius enable           start the MCP server and keep it on in every session (disable: off in every session)
/termius mode  <level>    global access level: read-only | review | auto | trusted (dangerously = trusted)
/termius route <mode>     global route: termius | termius-proxy | direct | proxy
/termius proxy <proxy>    system | off | socks5://… | http://…  (which proxy; routes decide who uses it)
/termius host <name> <level|inherit>   one host's access level, by label or id
/termius status           the menu's status lines as one message (also in print mode)
/termius sync             pull the host list now
/termius setup            install the server (installs uv first if neither uv nor Python 3.9+ is there)
```

`mode`, `route`, and `proxy` without a value open their sub-menu.

### Access levels

Each host has an access level, or follows the global one (default `auto`). A host's level comes from, first match: its temporary level for this session, its own level, the global level.

| Level | Reads (read-only commands, list/stat/read/get) | Writes | Catastrophic commands |
|---|---|---|---|
| `off` | refused | refused | refused |
| `read-only` | run | refused without asking | refused |
| `review` | ask | ask | ask |
| `auto` | run | ask | ask |
| `trusted` | run | run | ask |

- **`off`** hides the host from the agent: `hosts` leaves it out (and says how many are hidden), and `host` / `exec` / `files` naming it fail with `host_disabled`. The server enforces this itself. A disabled host still works as a jump host for other hosts; the list notes it.
- **Catastrophic commands** ask at every level, a session allow included: `rm -r` of `/` or a system directory, `mkfs*`, `wipefs`, `dd of=/dev/…`, writing partitions, `reboot` / `shutdown` / `poweroff` / `init 0|6`, flushing or turning off the firewall, stopping or disabling `sshd`, `userdel`, recursive `chmod` / `chown` of `/` or a system directory, `kill 1`, fork bombs. They are matched behind `sudo`, `env`, `timeout`, inside `sh -c '…'` and command substitutions. On a read-only host they are refused.
- **Reads** use fixed rules, not a model: a command is read-only only when every pipeline segment is an allowlisted read-only program (`ls`, `cat`, `tail`, `grep`, `df`, `ps`, `systemctl status`, `docker ps/logs`, `kubectl get/logs`, `journalctl`, `git log`, …) with no output redirection, command substitution, `sudo`, or backgrounding. Anything unrecognised counts as a write, so a gap in the rules costs a question, never a silent change.

The approval dialog shows the command, the host's address, the route this call takes, the effective level, and why it asks ("systemctl restart is not a read-only subcommand", or a red "catastrophic: reboots or powers off the host"). It offers *Allow once*, *Allow everything on this host for this session*, *Always trust this host* (saves `trusted`), *Deny*, *Deny and disable this host* (saves `off`), and *Deny and tell the agent why* (your words become the block reason, so the agent follows them instead of retrying). For a catastrophic command only *Allow once* and the deny choices are offered. Calls that arrive while a dialog is open wait their turn and are checked again, so allowing a host for the session settles the calls queued behind it. Without a UI (`pi -p`), calls that would ask are refused.

Session allows and temporary levels are keyed by the host's cloud id, so they hold whether the agent names the host by label or by id. They survive `/reload` (kept as a custom session entry, never in the model's context) and end with `/new`, a switch to another session, or quitting pi; a later `/resume` of the session does not bring them back.

The agent sees each host's effective level: `hosts` and `host` rows carry `access`, `access_source` (`temporary`, `host`, `global`), and `session_allowed`, and the tool descriptions say that read-only hosts refuse writes, so it can ask you before trying.

### Routes

A route says how a host is reached. The global route applies to every host without one of its own:

| Route | Hosts with a Termius jump host chain | Hosts without one |
|---|---|---|
| `termius` (default) | the chain, first hop dialed directly | the proxy setting (bypass list applies) |
| `termius-proxy` | the chain, first hop through the proxy | the proxy setting |
| `direct` | straight to the address, no chain, no proxy | direct |
| `proxy` | through the proxy straight to the address, no chain | through the proxy |

Switching networks usually means changing the global route once and overriding the exceptions per host. A route is followed exactly: if it does not connect, the call fails; nothing falls back to another route, and a route that needs a proxy when none is configured is an error rather than a direct connection. Every `exec` and `files` result lists the route taken; `host` shows the effective jump hosts, proxy, and an equivalent `ssh -J …` command.

Termius host chains work as in Termius: through each jump host in order, each hop with its own credentials and its own pinned host key. A chain set on a group applies to its hosts, and a jump host that has a chain of its own is reached through that chain first.

**Proxy** (`/termius proxy`) only says which proxy to use:

- `system` (the default): pi's `ALL_PROXY`, `HTTPS_PROXY`, or `HTTP_PROXY` (any case), with `NO_PROXY`;
- a URL: `socks5://`, `socks5h://`, `socks4://`, `socks4a://`, or `http://` (CONNECT), `user:password@` allowed. Loopback, private, and link-local addresses and `*.local` names stay direct under the `termius` routes, unless `proxyBypass` in `config.json` lists other ones;
- `off`: none.

A host can have its own proxy URL, which replaces the setting wherever its route uses a proxy. The `proxy` and `termius-proxy` routes use the proxy without the bypass list: you picked them on purpose.

### Footer

When the termius setup is not the default, the footer shows a small segment: the global route if it is not `termius`, and `+n` for hosts with a session allow or a temporary level (narrow terminals keep just the count); while a call runs, the host's label. Nothing shows when everything is default.

### Settings file

Everything above lives in `~/.pi/agent/termius-mcp/config.json` (mode 0600, replaced atomically): `mode` (global level), `route`, `proxy`, `proxyBypass`, `enabled`, `hosts` (per cloud id: `level`, `route`, `proxy`, and a `label` for display), and `knownHosts` (the baseline for the `new` mark; the first host list loaded becomes it). The server reads `hosts.*.level == "off"`, the routes, and the host proxy URLs from it on every call (`TERMIUS_MCP_POLICY`), so a change applies to the next call without a restart; an unreadable file fails closed. Settings are per machine; sign-out keeps them.

### Server

**On and off.** pi registers Termius from this extension, not from `mcp.json`, and pi's `/mcp` saves on/off for such a server only for the current session. `/termius disable` disconnects it at once and writes `"enabled": false` to `config.json`, so later sessions, `/reload`, and other open sessions at their next start leave it off; `/termius enable` starts it again. The local guard that keeps other tools away from `~/.termius` and the keychain entry stays active either way.

**Lifetime.** pi starts each MCP server in its own process group and ends the group when the session ends, also on SIGTERM / SIGHUP (closing the terminal); if pi is killed outright, the servers see their input close and exit. Checked for chrome-devtools (including the Chrome it launched) and Termius with SIGTERM, SIGHUP, and SIGKILL: nothing was left a second later. The Termius server also exits within a second when pi dies during a long `exec`, instead of finishing the command first.

**Timeouts and cancelling.** The `timeout` of `exec` and `files` (default 60 s) caps the whole call, every jump host included. A command that is still running then has its channel closed, and the agent gets the output so far with `timed_out: true` (the remote process may keep running). Each call runs in its own thread, so a long `exec` does not hold up `status` or other calls. While a call runs, the server sends a progress notification every 15 s; pi restarts its 60 s request timeout on each one, so an `exec` with `timeout: 600` gets its full ten minutes instead of being cut off by pi at 60 s. Output over 200000 characters keeps its start and its end; `files read` returns up to 200000 bytes at a time, with `offset` / `length` for the rest (a negative offset reads the tail of a log). Pressing Esc in pi cancels the call and closes its SSH connections.

**Setup.** The server goes into its own environment under `~/.pi/agent/termius-mcp/venv-<hash>`, built with [uv](https://docs.astral.sh/uv/) (which also fetches a Python when there is none) or a local Python 3.9+. It works the same on Linux, macOS, and Windows. When a preset update changes the vendored code, the next session builds a new environment next to the old one and moves its server over once the build succeeded (`installed.json` names the current one). Rebuilding in place failed on Windows, where a server still running in another pi window keeps its `termius.exe` locked; now that old environment is only removed later, keeping the current and the newest previous one, and skipped while still in use.

**Sign-in.** `/termius login` asks in pi's own masked prompts and hands the answers to the server process on stdin (`termius login-json`). They never pass through the model, the MCP protocol, the command line, or the environment. Two-factor accounts are asked for the authenticator code; a "approve this device" request waits until you approve it in the Termius app. The vault password is remembered in the OS keychain (an encrypted file where there is none), so later sessions sync on their own. Signing in also pulls the host list right away, so the menu and the agent see your hosts at once; if that first pull fails, the sign-in still stands and the next host call retries it. The menu's host list and connection test use two more `login-json` actions (`hosts`, `test`) that return no secrets.

**Sync.** One way, Termius Cloud to the local cache: the server downloads the vault, decrypts it with the vault password remembered at sign-in, and replaces its cache. It never uploads anything. A pull happens:

- on sign-in (a failed first pull leaves the sign-in valid);
- on `hosts` / `host` and when the menu's host list opens, when the cache is over 10 minutes old; if the pull fails they answer from the cache, marked `stale`;
- on `exec` / `files` / `inventory` when the cache is over `TERMIUS_SYNC_TTL` seconds old (default 300, about 3 s per pull); if that pull fails they also answer from the cache, marked `stale`, so a Termius Cloud outage does not stop SSH to hosts already cached (a host whose address now points at another machine still fails on its pinned host key);
- on `status` only when signed in but never synced;
- always on the `sync` tool and `/termius sync`.

Without a sign-in or a remembered vault password, the calls fail with `not_signed_in` / `vault_password_required`.

**What the model gets.** Seven tools: `status`, `sync`, `hosts`, `host`, `exec`, `files` (SFTP list/stat/read/get/put/write/mkdir/rm/rename), `inventory`. Host rows carry the cloud id, tags, the route, and (added by pi) the access level. Compared with upstream:

- No tool takes or returns a secret. The `login`, `login_complete`, and `logout` tools, which took the vault password as a model-visible argument, are gone; `sync` has no password argument; snippets are listed by label only, since their scripts can hold credentials.
- Every result is scrubbed: any identity password, key passphrase, private key, or the vault password in command output or file content becomes `[redacted]`, as does any PEM/OpenSSH private key block.
- Host keys are pinned on first connection in `~/.termius/known_hosts`; a changed key is refused instead of silently accepted (upstream used paramiko's `AutoAddPolicy`).
- Upstream dropped Termius's host chains when syncing, so every host was dialed directly; here they are kept and followed (see Routes).

**Local guard.** The agent's own tools run as your user, so it could in principle read the server's encrypted cache in `~/.termius`, ask the OS keychain for the vault password, or read the server process. The extension blocks tool calls whose paths or commands point there (`~/.termius`, keychain lookups mentioning termius, `/proc/<pid>/mem|environ`, `gdb -p`, …), and `files get` / `files put` cannot write to or upload from `~/.termius` or the server's directory (a `get` there would replace `config.json`, the levels and routes the approvals rest on, with remote content). The server refuses those paths too, after resolving symlinks. It also blocks running the server's own code outside the MCP tools: starting the installed server or `termius` CLI, importing the `termius` package, or running Python against the vendored source other than its test suite, and reading or writing the server's directory (its `config.json` holds the access levels and may hold a proxy password). The server decrypts the vault with the remembered password, so a script on top of it could read every credential, and calling it directly would skip the access levels. This stops the ordinary ways and makes intent visible; it is not an isolation boundary against an agent deliberately working around it as the same OS user. Running the server as a separate OS user would be that boundary.
