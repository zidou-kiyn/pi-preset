/**
 * termius — SSH into Termius hosts through the vendored termius-mcp server.
 *
 * The MCP server (vendor/termius-mcp, Python) holds the Termius vault: hosts,
 * identities, keys. The model reaches it through codemode as
 * mcp__termius__{status,sync,hosts,host,exec,files,inventory}; it sees
 * command output with vault secrets redacted, never a password or key.
 *
 * This extension:
 *   - registers the server (codemode exposure) once it is installed,
 *   - /termius setup | login | sync | status | mode | proxy | logout,
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
import { describeProxy, proxyServerEnv, proxyUrlError } from "../src/termius/proxy.ts";
import {
	findPython,
	findUv,
	install,
	installState,
	installUv,
	type LoginResponse,
	loginJson,
	readConfig,
	serverBinary,
	uvInstallerCommand,
	writeConfig,
} from "../src/termius/install.ts";

const SERVER = "termius";
const TOOL_PREFIX = `mcp__${SERVER}__`;

const MODE_HELP: Record<ApprovalMode, string> = {
	review: "every remote command and file operation asks first",
	auto: "read-only commands and file reads run; anything else asks",
	dangerously: "nothing asks",
};

export default function termiusExtension(pi: ExtensionAPI): void {
	let config = readConfig();
	/** Hosts the user allowed for the rest of this session. */
	const allowedHosts = new Set<string>();
	let installing: Promise<void> | undefined;

	const register = () => {
		pi.registerMcpServer(SERVER, {
			command: serverBinary(),
			args: [],
			env: proxyServerEnv(config),
			exposure: "codemode",
			description:
				"SSH into the user's Termius hosts: list hosts, run remote commands, SFTP files. Credentials stay in the server; output has vault secrets redacted.",
		});
	};

	if (installState() !== "missing") register();

	const reinstall = (ctx: ExtensionContext | ExtensionCommandContext, reason: string): Promise<void> => {
		installing ??= (async () => {
			ctx.ui.notify(`termius: ${reason}`, "info");
			try {
				await install({ log: (line) => ctx.ui.setStatus("termius", `termius: ${line}…`) });
				register();
				ctx.ui.notify("termius: MCP server ready", "info");
			} finally {
				ctx.ui.setStatus("termius", undefined);
				installing = undefined;
			}
		})();
		return installing;
	};

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig();
		allowedHosts.clear();
		if (installState() === "outdated") {
			reinstall(ctx, "the vendored server changed; reinstalling").catch((error: Error) =>
				ctx.ui.notify(`termius: reinstall failed. ${error.message}`, "error"),
			);
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
		const allowOnce = "Allow once";
		const allowHost = `Allow everything on ${host || "this host"} for this session`;
		const deny = "Deny";
		const choice = await ctx.ui.select(
			`termius (${config.mode}): run on a remote host?\n${describeCall(tool, args)}`,
			[allowOnce, allowHost, deny],
		);
		if (choice === allowOnce) return undefined;
		if (choice === allowHost) {
			allowedHosts.add(host);
			return undefined;
		}
		return { block: true, reason: "The user denied this remote command. Ask how to proceed instead of retrying." };
	});

	// ── /termius ────────────────────────────────────────────────────────────
	const notifyLogin = (ctx: ExtensionCommandContext, response: LoginResponse) => {
		if (response.ok) {
			// login-json pulls the inventory right after signing in; a failed
			// pull leaves the sign-in valid and is retried with /termius sync.
			const synced =
				response.synced === true
					? `${String(response.hosts ?? 0)} host(s) synced`
					: `the first sync failed (${String(response.sync_error ?? "unknown error")}); retry with /termius sync`;
			ctx.ui.notify(
				`termius: signed in as ${String(response.username ?? "?")}; ${synced}. Vault password remembered in the OS keychain.`,
				response.synced === true ? "info" : "warning",
			);
			register();
		} else {
			ctx.ui.notify(`termius: sign-in failed. ${response.error ?? response.code}`, "error");
		}
	};

	/** Run a login request, asking for an authenticator code or app approval when needed. */
	const loginWithRetries = async (ctx: ExtensionCommandContext, request: Record<string, unknown>) => {
		let response = await loginJson(request);
		for (let attempt = 0; attempt < 3 && !response.ok; attempt++) {
			if (response.code === "otp_required") {
				const otp = await promptMaskedWithUi(ctx, "Termius: two-factor code", "6-digit code from your authenticator app");
				if (!otp) return;
				response = await loginJson({ ...request, otp: otp.trim() });
			} else if (response.code === "approve_required") {
				const approved = await ctx.ui.confirm(
					"Termius: approve this sign-in",
					"Termius asks you to approve this new device in the Termius app on another device. Approve it there, then choose Yes to retry.",
				);
				if (!approved) return;
				response = await loginJson(request);
			} else {
				break;
			}
		}
		notifyLogin(ctx, response);
	};

	const login = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("termius: sign in from the interactive TUI (masked prompts), or run `termius login` in a terminal.", "warning");
			return;
		}
		if (installState() === "missing") {
			ctx.ui.notify("termius: run /termius setup first.", "warning");
			return;
		}
		const method = await ctx.ui.select("Termius: sign in with", ["Email and password", "Google"]);
		if (!method) return;
		if (method === "Google") {
			const start = await loginJson({ action: "google_url" });
			if (!start.ok) return notifyLogin(ctx, start);
			await ctx.ui.editor(
				"Open this URL in a browser and sign in with Google. When the page tries to open Termius, decline and copy the termius://app/continue-sso?... URL (see vendor/termius-mcp/README.md, \"Get the callback URL\"). Close this view to continue.",
				String(start.url),
			);
			const callback = await promptMaskedWithUi(ctx, "Termius: callback URL", "termius://app/continue-sso?...");
			if (!callback) return;
			const password = await promptMaskedWithUi(ctx, "Termius: vault encryption password", "the Termius encryption password, not the Google one");
			if (!password) return;
			await loginWithRetries(ctx, { action: "google", callback_url: callback.trim(), password });
			return;
		}
		const username = await ctx.ui.input("Termius: email", "you@example.com");
		if (!username) return;
		const password = await promptMaskedWithUi(ctx, "Termius: password", "account / vault password");
		if (!password) return;
		await loginWithRetries(ctx, { action: "email", username: username.trim(), password });
	};

	const setup = async (ctx: ExtensionCommandContext) => {
		if (!findUv() && !findPython()) {
			const installer = uvInstallerCommand();
			const ok =
				ctx.hasUI &&
				(await ctx.ui.confirm(
					"termius: install uv?",
					`The Termius MCP server is Python. uv sets up Python and its packages in one step and is not installed. Run the official installer?\n\n  ${installer.display}`,
				));
			if (!ok) {
				ctx.ui.notify(`termius: install uv (or Python 3.9+) first:\n  ${installer.display}`, "warning");
				return;
			}
			await installUv();
		}
		await reinstall(ctx, "installing the MCP server");
		ctx.ui.notify("termius: next, sign in with /termius login.", "info");
	};

	const sync = async (ctx: ExtensionCommandContext) => {
		if (installState() === "missing") {
			ctx.ui.notify("termius: run /termius setup first.", "warning");
			return;
		}
		ctx.ui.setStatus("termius", "termius: syncing…");
		try {
			const response = await loginJson({ action: "sync" });
			if (response.ok) {
				ctx.ui.notify(`termius: ${String(response.hosts ?? 0)} host(s) synced.`, "info");
				// Restart the server so it reads the refreshed cache.
				register();
			} else {
				ctx.ui.notify(`termius: sync failed. ${response.error ?? response.code}`, "error");
			}
		} finally {
			ctx.ui.setStatus("termius", undefined);
		}
	};

	const status = async (ctx: ExtensionCommandContext) => {
		const state = installState();
		const lines = [
			`install: ${state}${state === "missing" ? " (run /termius setup)" : ""}`,
			`mode: ${config.mode} (${MODE_HELP[config.mode]})`,
			`proxy: ${describeProxy(config)}; hosts with a Termius jump host chain always connect to the first jump host directly`,
		];
		if (state !== "missing") {
			const data = await loginJson({ action: "status" });
			if (data.ok) {
				lines.push(
					data.logged_in ? `signed in as ${String(data.username)}` : "not signed in (run /termius login)",
					`hosts: ${String(data.hosts ?? 0)}, last sync: ${String(data.last_synced || "never (run /termius sync)")}, vault password remembered: ${data.vault_remembered ? "yes" : "no"}`,
				);
			} else {
				lines.push(`status failed: ${data.error ?? data.code}`);
			}
		}
		ctx.ui.notify(`termius\n${lines.join("\n")}`, "info");
	};

	const setMode = async (ctx: ExtensionCommandContext, requested: string | undefined) => {
		let mode = requested;
		if (!mode && ctx.hasUI) {
			const choice = await ctx.ui.select(
				`termius approval mode (now: ${config.mode})`,
				APPROVAL_MODES.map((m) => `${m}: ${MODE_HELP[m]}`),
			);
			mode = choice?.split(":")[0];
		}
		if (!isApprovalMode(mode)) {
			ctx.ui.notify(`termius: mode is one of ${APPROVAL_MODES.join(", ")}`, "warning");
			return;
		}
		config = { ...config, mode };
		writeConfig(config);
		allowedHosts.clear();
		ctx.ui.notify(`termius: approval mode ${mode} (${MODE_HELP[mode]})`, mode === "dangerously" ? "warning" : "info");
	};

	const setProxy = async (ctx: ExtensionCommandContext, requested: string | undefined) => {
		let value = requested?.trim();
		if (!value && ctx.hasUI) {
			const system = "Follow the system proxy variables (ALL_PROXY / HTTPS_PROXY / HTTP_PROXY, NO_PROXY)";
			const url = "Use a proxy URL…";
			const direct = "Direct: no proxy";
			const choice = await ctx.ui.select(`termius proxy (now: ${describeProxy(config)})`, [system, url, direct]);
			if (!choice) return;
			if (choice === system) value = "system";
			else if (choice === direct) value = "off";
			else {
				const entered = await promptMaskedWithUi(ctx, "termius: proxy URL", "socks5://127.0.0.1:7890  (user:password@ allowed)");
				if (!entered) return;
				value = entered.trim();
			}
		}
		if (!value) {
			ctx.ui.notify(`termius: proxy is ${describeProxy(config)}. Use /termius proxy <url> | system | off.`, "info");
			return;
		}
		const next = { ...config };
		if (value === "system") {
			delete next.proxy;
			delete next.proxyBypass;
		} else if (value === "off" || value === "direct") {
			next.proxy = "off";
			delete next.proxyBypass;
		} else {
			const error = proxyUrlError(value);
			if (error) {
				ctx.ui.notify(`termius: ${error}`, "warning");
				return;
			}
			next.proxy = value;
		}
		config = next;
		writeConfig(config);
		if (installState() !== "missing") register();
		ctx.ui.notify(`termius: proxy ${describeProxy(config)}. Applies to hosts without a jump host chain.`, "info");
	};

	const logout = async (ctx: ExtensionCommandContext) => {
		if (installState() === "missing") return;
		if (ctx.hasUI && !(await ctx.ui.confirm("termius: sign out?", "Removes the session, the remembered vault password, and the local host cache."))) return;
		const response = await loginJson({ action: "logout" });
		ctx.ui.notify(response.ok ? "termius: signed out" : `termius: sign-out failed. ${response.error}`, response.ok ? "info" : "error");
		register();
	};

	const SUBCOMMANDS = ["setup", "login", "sync", "status", "mode", "proxy", "logout"] as const;

	pi.registerCommand("termius", {
		description: "Termius SSH via MCP: setup, login, sync, status, mode (review|auto|dangerously), proxy, logout",
		getArgumentCompletions: (prefix) => {
			const [first, second] = prefix.trimStart().split(/\s+/);
			if (first === "mode" && second !== undefined) {
				return APPROVAL_MODES.filter((m) => m.startsWith(second)).map((m) => ({ value: `mode ${m}`, label: m }));
			}
			const matches = SUBCOMMANDS.filter((command) => command.startsWith(first ?? ""));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let [sub, value] = args.trim().split(/\s+/).filter(Boolean);
			if (!sub && ctx.hasUI) {
				sub = await ctx.ui.select("termius", [...SUBCOMMANDS]);
			}
			try {
				switch (sub) {
					case "setup":
						return await setup(ctx);
					case "login":
						return await login(ctx);
					case "sync":
						return await sync(ctx);
					case "status":
						return await status(ctx);
					case "mode":
						return await setMode(ctx, value);
					case "proxy":
						return await setProxy(ctx, value);
					case "logout":
						return await logout(ctx);
					case undefined:
						return;
					default:
						ctx.ui.notify(`termius: unknown subcommand ${sub}; use ${SUBCOMMANDS.join(" | ")}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(`termius: ${(error as Error).message}`, "error");
			}
		},
	});
}
