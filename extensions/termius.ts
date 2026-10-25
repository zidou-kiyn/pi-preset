/**
 * termius — SSH into Termius hosts through the vendored termius-mcp server.
 *
 * The MCP server (vendor/termius-mcp, Python) holds the Termius vault: hosts,
 * identities, keys. The model reaches it through codemode as
 * mcp__termius__{status,sync,hosts,host,exec,files,inventory}; it sees
 * command output with vault secrets redacted, never a password or key.
 *
 * This extension:
 *   - registers the server (codemode exposure) once it is installed, unless it
 *     was turned off here (saved in its config.json, so it holds in every
 *     session; pi's /mcp can only switch an extension-registered server off
 *     for the current session),
 *   - /termius: one menu (src/preset-menu.ts) with the live state at the top
 *     (install, on/off, account, hosts, last sync, approval mode, proxy) and
 *     only the actions that apply: sign in or sign out, turn on or off, mode,
 *     proxy. The first /termius installs the server; updates reinstall on
 *     session start. The vault syncs on its own (on sign-in and whenever the
 *     agent's hosts/host calls find the cache over 10 minutes old, its
 *     exec/files/inventory calls over TERMIUS_SYNC_TTL, 60 s), so there is
 *     no sync item. Typed subcommands (`/termius mode auto`, `login`, `sync`,
 *     …) still work,
 *   - gates exec/files by the approval mode (review / auto / dangerously),
 *   - blocks other tools from reading ~/.termius, the keychain entry, or
 *     process memory (src/termius/guard.ts).
 *
 * Sign-in happens here, in pi's UI: credentials go from a masked prompt to
 * the server's `login-json` on stdin and never pass through the model.
 *
 * Runtime: pi-preset/extensions/termius.ts
 * Command: /termius
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseValue, type MenuItem, type Notice, Signal, showMenu } from "../src/preset-menu.ts";
import { promptMaskedWithUi } from "../src/preset-ui.ts";
import {
	APPROVAL_MODES,
	type ApprovalMode,
	classifyTermiusCall,
	describeCall,
	GATED_TERMIUS_TOOLS,
	isApprovalMode,
	needsApproval,
} from "../src/termius/approval.ts";
import { guardToolCall } from "../src/termius/guard.ts";
import {
	findPython,
	findUv,
	install,
	installState,
	installUv,
	isEnabled,
	type LoginResponse,
	loginJson,
	readConfig,
	removeOldEnvironments,
	serverBinary,
	type TermiusConfig,
	uvInstallerCommand,
	writeConfig,
} from "../src/termius/install.ts";
import { describeProxy, proxyServerEnv, proxyUrlError } from "../src/termius/proxy.ts";

const SERVER = "termius";
const TOOL_PREFIX = `mcp__${SERVER}__`;

const MODE_HELP: Record<ApprovalMode, string> = {
	review: "every remote command and file operation asks first",
	auto: "read-only commands and file reads run; anything else asks",
	dangerously: "nothing asks",
};

const SUBCOMMANDS = ["setup", "login", "sync", "status", "mode", "proxy", "enable", "disable", "logout"] as const;

/** "3 min ago" for an ISO time; the raw text when it does not parse. */
export function ago(value: unknown, now = Date.now()): string {
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(time)) return String(value || "never");
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
	return `${Math.round(seconds / 86400)} d ago`;
}

interface AccountState {
	loading: boolean;
	data?: LoginResponse;
}

export default function termiusExtension(pi: ExtensionAPI): void {
	let config = readConfig();
	/** Hosts the user allowed for the rest of this session. */
	const allowedHosts = new Set<string>();
	let installing: Promise<void> | undefined;
	let installStep: string | undefined;
	let installError: string | undefined;
	let registered = false;
	let account: AccountState = { loading: false };
	const changed = new Signal();

	/** (Re)start the server with the current config; a no-op while disabled. */
	const register = () => {
		if (!isEnabled(config)) return;
		registered = true;
		pi.registerMcpServer(SERVER, {
			command: serverBinary(),
			args: [],
			env: proxyServerEnv(config),
			exposure: "codemode",
			description:
				"SSH into the user's Termius hosts: list hosts, run remote commands, SFTP files. Credentials stay in the server; output has vault secrets redacted.",
		});
	};

	/** Disconnect the server and drop its tools for this session. */
	const unregister = () => {
		if (!registered) return;
		registered = false;
		pi.unregisterMcpServer(SERVER);
	};

	if (installState() !== "missing") register();

	/** Build the environment for the current source, then move this session's server onto it. */
	const reinstall = (): Promise<void> => {
		installing ??= (async () => {
			installError = undefined;
			changed.emit();
			try {
				await install({
					log: (line) => {
						installStep = line;
						changed.emit();
					},
				});
				register();
			} catch (error) {
				installError = (error as Error).message;
				throw error;
			} finally {
				installStep = undefined;
				installing = undefined;
				changed.emit();
			}
		})();
		return installing;
	};

	/** Fetch the account state in the background; the menu re-renders when it arrives. */
	const refreshAccount = () => {
		if (installState() === "missing" || installing) return;
		account = { ...account, loading: true };
		changed.emit();
		loginJson({ action: "status" })
			.then((data) => {
				account = { loading: false, data };
			})
			.catch((error: Error) => {
				account = { loading: false, data: { ok: false, error: error.message } };
			})
			.finally(() => changed.emit());
	};

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig();
		allowedHosts.clear();
		// Another session may have turned the server on or off since this one loaded.
		if (!isEnabled(config)) unregister();
		else if (!registered && installState() !== "missing") register();
		if (isEnabled(config) && installState() === "outdated") {
			ctx.ui.setStatus("termius", "termius: updating…");
			reinstall()
				.then(() => ctx.ui.notify("termius: MCP server updated", "info"))
				.catch((error: Error) => ctx.ui.notify(`termius: update failed. ${error.message}`, "error"))
				.finally(() => ctx.ui.setStatus("termius", undefined));
		} else {
			removeOldEnvironments();
		}
	});

	// ── tool gate ───────────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		const verdict = guardToolCall(event.toolName, event.input);
		if (verdict.block) return { block: true, reason: verdict.reason };

		if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
		const tool = event.toolName.slice(TOOL_PREFIX.length);
		if (!GATED_TERMIUS_TOOLS.has(tool)) return undefined;

		const args = (event.input ?? {}) as Record<string, unknown>;
		const kind = classifyTermiusCall(tool, args);
		if (!needsApproval(config.mode, kind)) return undefined;
		const host = String(args.name ?? "");
		if (allowedHosts.has(host)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `termius ${config.mode} mode: this ${kind === "write" ? "command may change the host" : "call"} needs the user's approval, and this session has no UI to ask in.`,
			};
		}
		const choice = await showMenu(ctx, () => ({
			title: `termius (${config.mode}): run on a remote host?`,
			status: describeCall(tool, args).split("\n"),
			items: [
				{ value: "once", label: "Allow once" },
				{ value: "host", label: `Allow everything on ${host || "this host"} for this session` },
				{ value: "deny", label: "Deny" },
			],
			cancelLabel: "deny",
		}));
		if (choice === "once") return undefined;
		if (choice === "host") {
			allowedHosts.add(host);
			return undefined;
		}
		return { block: true, reason: "The user denied this remote command. Ask how to proceed instead of retrying." };
	});

	// ── actions (each returns what happened; the menu shows it, typed commands notify it) ──

	const loginNotice = (response: LoginResponse): Notice => {
		if (!response.ok) return { text: `Sign-in failed. ${response.error ?? response.code}`, type: "error" };
		register();
		// login-json pulls the inventory right after signing in; a failed pull
		// leaves the sign-in valid and is retried by the next host call.
		return response.synced === true
			? { text: `Signed in as ${String(response.username ?? "?")}; ${String(response.hosts ?? 0)} host(s) synced. Vault password remembered in the OS keychain.`, type: "success" }
			: {
					text: `Signed in as ${String(response.username ?? "?")}, but the first sync failed (${String(response.sync_error ?? "unknown error")}). It is retried when the agent next uses hosts.`,
					type: "warning",
				};
	};

	/** Run a login request, asking for an authenticator code or app approval when needed. */
	const loginWithRetries = async (ctx: ExtensionCommandContext, request: Record<string, unknown>): Promise<Notice | undefined> => {
		let response = await loginJson(request);
		for (let attempt = 0; attempt < 3 && !response.ok; attempt++) {
			if (response.code === "otp_required") {
				const otp = await promptMaskedWithUi(ctx, "Termius: two-factor code", "6-digit code from your authenticator app");
				if (!otp) return undefined;
				response = await loginJson({ ...request, otp: otp.trim() });
			} else if (response.code === "approve_required") {
				const next = await showMenu(ctx, () => ({
					title: "Termius: approve this sign-in",
					status: ["Termius asks you to approve this new device in the Termius app on another device."],
					items: [{ value: "retry", label: "I approved it, continue" }],
					cancelLabel: "cancel",
				}));
				if (next !== "retry") return undefined;
				response = await loginJson(request);
			} else {
				break;
			}
		}
		return loginNotice(response);
	};

	const login = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		if (ctx.mode !== "tui") {
			return { text: "Sign in from the interactive TUI (masked prompts), or run `termius login` in a terminal.", type: "warning" };
		}
		const method = await chooseValue(
			ctx,
			"Termius: sign in with",
			[
				{ value: "email", label: "Email and password" },
				{ value: "google", label: "Google", description: "Opens Termius' Google sign-in; you paste back the termius:// callback URL and enter the vault encryption password." },
			],
			"email",
		);
		if (!method) return undefined;
		if (method === "google") {
			const start = await loginJson({ action: "google_url" });
			if (!start.ok) return loginNotice(start);
			await ctx.ui.editor(
				"Open this URL in a browser and sign in with Google. When the page tries to open Termius, decline and copy the termius://app/continue-sso?... URL (see vendor/termius-mcp/README.md, \"Get the callback URL\"). Close this view to continue.",
				String(start.url),
			);
			const callback = await promptMaskedWithUi(ctx, "Termius: callback URL", "termius://app/continue-sso?...");
			if (!callback) return undefined;
			const password = await promptMaskedWithUi(ctx, "Termius: vault encryption password", "the Termius encryption password, not the Google one");
			if (!password) return undefined;
			return loginWithRetries(ctx, { action: "google", callback_url: callback.trim(), password });
		}
		const username = await ctx.ui.input("Termius: email", "you@example.com");
		if (!username) return undefined;
		const password = await promptMaskedWithUi(ctx, "Termius: password", "account / vault password");
		if (!password) return undefined;
		return loginWithRetries(ctx, { action: "email", username: username.trim(), password });
	};

	/** Install uv when neither uv nor Python exists (asks first), then the server. */
	const setup = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		if (!findUv() && !findPython()) {
			const installer = uvInstallerCommand();
			const ok =
				ctx.hasUI &&
				(await showMenu(ctx, () => ({
					title: "termius: install uv?",
					status: [
						"The Termius MCP server is Python. uv sets up Python and its packages in one step and is not installed. Run the official installer?",
						installer.display,
					],
					items: [{ value: "yes", label: "Install uv, then the server" }],
					cancelLabel: "cancel",
				}))) === "yes";
			if (!ok) return { text: `Install uv (or Python 3.9+) first: ${installer.display}`, type: "warning" };
			await installUv();
		}
		try {
			await reinstall();
		} catch (error) {
			return { text: `Install failed. ${(error as Error).message}`, type: "error" };
		}
		refreshAccount();
		return { text: "MCP server installed.", type: "success" };
	};

	const sync = async (): Promise<Notice> => {
		if (installState() === "missing") return { text: "Not installed yet; open /termius to install.", type: "warning" };
		const response = await loginJson({ action: "sync" });
		if (!response.ok) return { text: `Sync failed. ${response.error ?? response.code}`, type: "error" };
		register(); // restart the server so it reads the refreshed cache
		return { text: `${String(response.hosts ?? 0)} host(s) synced.`, type: "success" };
	};

	const setEnabled = async (enabled: boolean): Promise<Notice> => {
		if (isEnabled(config) !== enabled) {
			const next: TermiusConfig = { ...config };
			if (enabled) delete next.enabled;
			else next.enabled = false;
			config = next;
			writeConfig(config);
		}
		if (!enabled) {
			unregister();
			allowedHosts.clear();
			return { text: "MCP server off in every session.", type: "info" };
		}
		if (installState() === "missing") return { text: "Turned on; the server is installed the next time you open /termius.", type: "info" };
		// Sessions skip the update reinstall while it is off; catch up now.
		if (installState() === "outdated") {
			try {
				await reinstall();
			} catch (error) {
				return { text: `Update failed. ${(error as Error).message}`, type: "error" };
			}
		} else if (!registered) register();
		return { text: "MCP server on in every session.", type: "success" };
	};

	const applyMode = (mode: ApprovalMode): Notice => {
		config = { ...config, mode };
		writeConfig(config);
		allowedHosts.clear();
		return { text: `Approval mode ${mode}: ${MODE_HELP[mode]}.`, type: mode === "dangerously" ? "warning" : "success" };
	};

	const chooseMode = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const mode = await chooseValue(
			ctx,
			"termius: approval mode",
			APPROVAL_MODES.map((m) => ({ value: m, label: m, description: MODE_HELP[m] })),
			config.mode,
		);
		return isApprovalMode(mode) && mode !== config.mode ? applyMode(mode) : undefined;
	};

	const applyProxy = (value: string): Notice => {
		const next: TermiusConfig = { ...config };
		if (value === "system") {
			delete next.proxy;
			delete next.proxyBypass;
		} else if (value === "off" || value === "direct") {
			next.proxy = "off";
			delete next.proxyBypass;
		} else {
			const error = proxyUrlError(value);
			if (error) return { text: error, type: "warning" };
			next.proxy = value;
		}
		config = next;
		writeConfig(config);
		if (installState() !== "missing") register();
		return { text: `Proxy: ${describeProxy(config)}. Applies to hosts without a jump host chain.`, type: "success" };
	};

	const chooseProxy = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const current = config.proxy === undefined ? "system" : config.proxy === "off" ? "off" : "url";
		const choice = await chooseValue(
			ctx,
			"termius: proxy",
			[
				{ value: "system", label: "System proxy variables", description: "ALL_PROXY / HTTPS_PROXY / HTTP_PROXY, with NO_PROXY" },
				{ value: "url", label: "A proxy URL…", description: "socks5://, socks5h://, socks4://, socks4a://, or http:// (CONNECT); user:password@ allowed" },
				{ value: "off", label: "Direct: no proxy" },
			],
			current,
			[`now: ${describeProxy(config)}`, "Hosts with a Termius jump host chain always connect to the first jump host directly."],
		);
		if (!choice) return undefined;
		if (choice !== "url") return choice === current ? undefined : applyProxy(choice);
		const entered = await promptMaskedWithUi(ctx, "termius: proxy URL", "socks5://127.0.0.1:7890  (user:password@ allowed)");
		return entered?.trim() ? applyProxy(entered.trim()) : undefined;
	};

	const logout = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		if (installState() === "missing") return undefined;
		if (ctx.hasUI) {
			const sure = await showMenu(ctx, () => ({
				title: "termius: sign out?",
				status: ["Removes the session, the remembered vault password, and the local host cache."],
				items: [{ value: "yes", label: "Sign out" }],
				cancelLabel: "cancel",
			}));
			if (sure !== "yes") return undefined;
		}
		const response = await loginJson({ action: "logout" });
		register();
		return response.ok ? { text: "Signed out.", type: "info" } : { text: `Sign-out failed. ${response.error}`, type: "error" };
	};

	// ── the menu ────────────────────────────────────────────────────────────

	const statusLines = (): string[] => {
		const state = installState();
		const lines: string[] = [];
		if (installing) lines.push(`Server: installing… ${installStep ?? ""}`.trim());
		else if (installError) lines.push(`Server: install failed. ${installError}`);
		else if (state === "missing") lines.push("Server: not installed");
		else if (state === "outdated") lines.push("Server: update pending (applied on turning it on or the next session)");
		lines.push(isEnabled(config) ? "MCP server: on (the agent can use your Termius hosts)" : "MCP server: off in every session");
		if (state !== "missing" && !installing) {
			const data = account.data;
			if (account.loading && !data) lines.push("Account: checking…");
			else if (data?.ok && data.logged_in) {
				lines.push(`Signed in as ${String(data.username)} · ${String(data.hosts ?? 0)} host(s) · synced ${ago(data.last_synced)}${data.vault_remembered ? "" : " · vault password not remembered"}`);
			} else if (data?.ok) lines.push("Not signed in");
			else if (data) lines.push(`Account: ${data.error ?? data.code ?? "unknown"}`);
		}
		lines.push(`Approval: ${config.mode} (${MODE_HELP[config.mode]})`);
		return lines;
	};

	const menuItems = (): MenuItem[] => {
		const items: MenuItem[] = [];
		const state = installState();
		if (state === "missing" && !installing) {
			items.push({ value: "setup", label: "Install the MCP server", description: "Creates its Python environment (uv, or a local Python 3.9+); asks first if uv has to be installed." });
		}
		if (state !== "missing" && !installing) {
			const signedIn = account.data?.ok && account.data.logged_in;
			if (signedIn) items.push({ value: "logout", label: "Sign out", description: "Removes the session, the remembered vault password, and the local host cache." });
			else items.push({ value: "login", label: "Sign in", description: "Email and password, or Google. Credentials go to the server on stdin, never through the model." });
		}
		items.push(
			isEnabled(config)
				? { value: "disable", label: "Turn the MCP server off", description: "Stops it now and keeps it off in every session." }
				: { value: "enable", label: "Turn the MCP server on", description: "Starts it now and in every session." },
			{ value: "mode", label: "Approval mode", hint: config.mode, description: MODE_HELP[config.mode] },
			{ value: "proxy", label: "Proxy", hint: config.proxy === undefined ? "system" : config.proxy === "off" ? "direct" : "URL", description: describeProxy(config) },
		);
		return items;
	};

	const runMenu = async (ctx: ExtensionCommandContext) => {
		let notice: Notice | undefined;
		let selected: string | undefined;
		// First open: install right away when uv or Python is there (no question to ask).
		if (installState() === "missing" && !installing && (findUv() || findPython())) {
			reinstall()
				.then(() => {
					// The account line below says whether a sign-in is still needed.
					notice = { text: "MCP server installed.", type: "success" };
					refreshAccount();
				})
				.catch(() => {});
		}
		refreshAccount();
		for (;;) {
			const choice = await showMenu(
				ctx,
				() => ({ title: "Termius", status: statusLines(), notice, items: menuItems(), selected }),
				changed.subscribe,
			);
			if (!choice) return;
			selected = choice;
			try {
				const result = await runAction(ctx, choice);
				if (result) notice = result;
			} catch (error) {
				notice = { text: (error as Error).message, type: "error" };
			}
			if (choice === "login" || choice === "logout") refreshAccount();
		}
	};

	const runAction = async (ctx: ExtensionCommandContext, action: string, value?: string): Promise<Notice | undefined> => {
		switch (action) {
			case "setup":
				return setup(ctx);
			case "login":
				return login(ctx);
			case "logout":
				return logout(ctx);
			case "sync":
				return sync();
			case "enable":
				return setEnabled(true);
			case "disable":
				return setEnabled(false);
			case "mode":
				if (value === undefined) return chooseMode(ctx);
				return isApprovalMode(value) ? applyMode(value) : { text: `Mode is one of ${APPROVAL_MODES.join(", ")}.`, type: "warning" };
			case "proxy":
				return value === undefined ? chooseProxy(ctx) : applyProxy(value);
			default:
				return { text: `Unknown subcommand ${action}; use ${SUBCOMMANDS.join(" | ")}.`, type: "warning" };
		}
	};

	/** `/termius status` outside the menu, e.g. in print mode. */
	const printStatus = async (ctx: ExtensionCommandContext) => {
		if (installState() !== "missing") account = { loading: false, data: await loginJson({ action: "status" }) };
		ctx.ui.notify(`termius\n${statusLines().join("\n")}\nProxy: ${describeProxy(config)}`, "info");
	};

	pi.registerCommand("termius", {
		description: "Termius SSH via MCP: sign in, on/off, approval mode, proxy (subcommands: login, logout, enable, disable, mode, proxy, status, sync, setup)",
		getArgumentCompletions: (prefix) => {
			const [first, second] = prefix.trimStart().split(/\s+/);
			if (first === "mode" && second !== undefined) {
				return APPROVAL_MODES.filter((m) => m.startsWith(second)).map((m) => ({ value: `mode ${m}`, label: m }));
			}
			const matches = SUBCOMMANDS.filter((command) => command.startsWith(first ?? ""));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const sub = words[0];
			try {
				if (!sub) {
					if (ctx.hasUI) await runMenu(ctx);
					else await printStatus(ctx);
					return;
				}
				if (sub === "status") return await printStatus(ctx);
				const result = await runAction(ctx, sub, words[1]);
				if (result) ctx.ui.notify(`termius: ${result.text}`, result.type === "success" ? "info" : result.type);
			} catch (error) {
				ctx.ui.notify(`termius: ${(error as Error).message}`, "error");
			}
		},
	});
}
