# MCP servers

## Codemode exposure

Both MCP servers below use `exposure: "codemode"`: none of their tools is declared to the model. The model calls them from a `codemode` script (`tools.mcp__chrome_devtools__navigate_page(...)`, `tools.mcp__termius__exec(...)`), finds signatures with `describeNamespace()` / `describeTool()`, and returns only what it needs, so a script can chain several calls and filter large output (page snapshots, logs from many hosts) before anything reaches the context. The tool declarations never change mid-session, and the only standing cost is the one `codemode` tool.

## Browser: the chrome-devtools MCP server

Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) runs through pi's built-in MCP support instead of a browser extension. **Sync preset** adds it to `~/.pi/agent/mcp.json`, pinned (`chrome-devtools-mcp@1.10.1`, via `npx`), with telemetry, CrUX lookups, and update checks off, and codemode exposure (its 30 tools are called from scripts). On the first browser call it starts its own Chrome with a separate profile. Turn it off in `/mcp`; the sync does not own `enabled`. Bump the version in `src/manifest.ts` after reading its changelog.

## SSH: the Termius MCP server

[`vendor/termius-mcp`](../vendor/termius-mcp) is [MiaM1ku/termius-mcp](https://github.com/MiaM1ku/termius-mcp) (Python, BSD, a fork of the official Termius CLI), hardened here, and [`extensions/termius.ts`](../extensions/termius.ts) installs and registers it. The agent can list your Termius hosts and run commands or move files on them over SSH with the hosts' own usernames, passwords, and keys, without ever seeing those secrets.

```
/termius setup     install the server (one step; installs uv first if neither uv nor Python 3.9+ is there)
/termius login     sign in: email + password, or Google; asks for the 2FA code / app approval when Termius wants one
/termius mode      review | auto | dangerously
/termius proxy     system | off | socks5://… | http://…  (proxy for hosts without a jump host)
/termius sync      pull the host list from Termius Cloud now (sign-in already does this once)
/termius status    install state, on/off, account, host count, last sync, mode
/termius disable   stop the MCP server and keep it off in every session (enable turns it back on)
/termius logout    sign out and wipe the local host cache
```

**On and off.** pi registers Termius from this extension, not from `mcp.json`, and pi's `/mcp` saves on/off for such a server only for the current session. `/termius disable` disconnects it at once and writes `"enabled": false` to the server's `config.json` (next to its venv), so later sessions, `/reload`, and other open sessions at their next start leave it off; `/termius enable` starts it again. The local guard that keeps other tools away from `~/.termius` and the keychain entry stays active either way.

**Lifetime.** pi starts each MCP server in its own process group and ends the group when the session ends, also on SIGTERM / SIGHUP (closing the terminal); if pi is killed outright, the servers see their input close and exit. Checked for chrome-devtools (including the Chrome it launched) and Termius with SIGTERM, SIGHUP, and SIGKILL: nothing was left a second later. The Termius server also exits within a second when pi dies during a long `exec`, instead of finishing the command first.

**Timeouts and cancelling.** The `timeout` of `exec` and `files` (default 60 s) caps the whole call, every jump host included. A command that is still running then has its channel closed, and the agent gets the output so far with `timed_out: true` (the remote process may keep running). Each call runs in its own thread, so a long `exec` does not hold up `status` or other calls. Pressing Esc in pi cancels the call and closes its SSH connections.

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

**Local guard.** The agent's own tools run as your user, so it could in principle read the server's encrypted cache in `~/.termius`, ask the OS keychain for the vault password, or read the server process. The extension blocks tool calls whose paths or commands point there (`~/.termius`, keychain lookups mentioning termius, `/proc/<pid>/mem|environ`, `gdb -p`, …), and `files put` cannot upload from `~/.termius`. It also blocks running the server's own code outside the MCP tools: starting the installed server or `termius` CLI, importing the `termius` package, or running Python against the vendored source other than its test suite. The server decrypts the vault with the remembered password, so a script on top of it could read every credential, and calling it directly would skip the approval modes. This stops the ordinary ways and makes intent visible; it is not an isolation boundary against an agent deliberately working around it as the same OS user. Running the server as a separate OS user would be that boundary.
