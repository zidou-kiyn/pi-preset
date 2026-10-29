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
 *     session);
 *   - gates exec / files by access level, per host (src/termius/gate.ts):
 *     off / read-only / review / auto / trusted, temporary levels and
 *     session allows, catastrophic commands that always ask;
 *   - adds each host's effective level to `hosts` / `host` results and logs
 *     every remote call (src/termius/activity.ts);
 *   - /termius: a menu with the live state at the top and only the actions
 *     that apply: hosts (levels, routes, temporary grants, connection test),
 *     global level, global route, proxy, recent activity, sign in / out,
 *     on / off. Typed subcommands (`/termius mode auto`, `route direct`,
 *     `host web read-only`, `login`, `sync`, …) still work;
 *   - shows a footer segment when the setup is not the default
 *     (src/termius/footer-state.ts);
 *   - blocks other tools from reading ~/.termius, the keychain entry, or
 *     process memory (src/termius/guard.ts).
 *
 * The server enforces disabled hosts and routes itself, re-reading
 * config.json (TERMIUS_MCP_POLICY) on every call. Sign-in happens here, in
 * pi's UI: credentials go from a masked prompt to the server's `login-json`
 * on stdin and never pass through the model. The design is in
 * docs/termius-design.md.
 *
 * Runtime: pi-preset/extensions/termius.ts
 * Command: /termius
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseValue, type MenuItem, type Notice, Signal, showMenu } from "../src/preset-menu.ts";
import { promptMaskedWithUi } from "../src/preset-ui.ts";
import { activityToday, appendActivity, clearActivity, readActivity } from "../src/termius/activity.ts";
import { runActivityView } from "../src/termius/activity-view.ts";
import {
	configPath,
	globalRoute,
	isEnabled,
	isRouteMode,
	markKnown,
	ROUTE_MODES,
	readConfig,
	type TermiusConfig,
	updateConfig,
	updateHost,
} from "../src/termius/config.ts";
import { footerIsEmpty, footerText, publishFooter, TERMIUS_STATUS_KEY, type TermiusFooterSnapshot } from "../src/termius/footer-state.ts";
import { ago } from "../src/termius/format.ts";
import { TermiusGate } from "../src/termius/gate.ts";
import { guardToolCall } from "../src/termius/guard.ts";
import { HostIndex } from "../src/termius/host-index.ts";
import { runHostsMenu } from "../src/termius/hosts-menu.ts";
import {
	findPython,
	findUv,
	install,
	installState,
	installUv,
	type LoginResponse,
	loginJson,
	removeOldEnvironments,
	serverBinary,
	uvInstallerCommand,
} from "../src/termius/install.ts";
import { GLOBAL_LEVELS, type GlobalLevel, isLevel, type Level, parseGlobalLevel } from "../src/termius/levels.ts";
import { messages } from "../src/termius/messages.ts";
import { describeProxy, proxyServerEnv, proxyUrlError } from "../src/termius/proxy.ts";
import { lastSnapshot, SESSION_ENTRY, SessionGrants } from "../src/termius/session-state.ts";

export { ago };

const SERVER = "termius";
const UPDATE_STATUS_KEY = "termius-update";

const SUBCOMMANDS = ["setup", "login", "logout", "sync", "status", "mode", "route", "proxy", "host", "enable", "disable"] as const;

interface AccountState {
	loading: boolean;
	data?: LoginResponse;
}

export default function termiusExtension(pi: ExtensionAPI): void {
	let config = readConfig();
	const grants = new SessionGrants();
	const changed = new Signal();
	let installing: Promise<void> | undefined;
	let installStep: string | undefined;
	let installError: string | undefined;
	let registered = false;
	let account: AccountState = { loading: false };
	let activeHosts: string[] = [];
	let statusCtx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;

	/** What the server process and login-json get: the proxy and where the policy file is. */
	const serverEnv = (): Record<string, string> => ({ ...proxyServerEnv(config), TERMIUS_MCP_POLICY: configPath() });

	/** (Re)start the server with the current config; a no-op while disabled. */
	const register = () => {
		if (!isEnabled(config)) return;
		registered = true;
		pi.registerMcpServer(SERVER, {
			command: serverBinary(),
			args: [],
			env: serverEnv(),
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

	// ── footer ──────────────────────────────────────────────────────────────

	const updateFooter = () => {
		const route = globalRoute(config);
		const snapshot: TermiusFooterSnapshot = {
			route: route === "termius" ? undefined : route,
			grants: grants.count,
			active: activeHosts.at(-1),
			moreActive: Math.max(0, activeHosts.length - 1),
		};
		const empty = footerIsEmpty(snapshot);
		publishFooter(empty ? undefined : snapshot);
		if (statusCtx?.hasUI) statusCtx.ui.setStatus(TERMIUS_STATUS_KEY, empty ? undefined : `termius ${footerText(snapshot, messages().routeName)}`);
	};

	/** Save a config change (re-reading the file first) and refresh what shows it. */
	const update = (change: (current: TermiusConfig) => TermiusConfig) => {
		config = updateConfig(change);
		updateFooter();
		changed.emit();
	};

	const hosts = new HostIndex(async (sync) => {
		if (installState() === "missing") return { ok: false, code: "not_installed", error: messages().notInstalled };
		const response = await loginJson({ action: "hosts", sync }, serverEnv());
		// The first list is the baseline: hosts in it are not marked new.
		if (response.ok === true && Array.isArray(response.hosts) && readConfig().knownHosts === undefined) {
			const keys = response.hosts.map((row) => String((row as Record<string, unknown>).cloud_id ?? "")).filter(Boolean);
			update((current) => (current.knownHosts ? current : markKnown(current, keys)));
		}
		return response;
	});

	/** Session grants changed: keep them in the session (for /reload) and redraw. */
	const grantsChanged = () => {
		pi.appendEntry(SESSION_ENTRY, grants.snapshot());
		updateFooter();
		changed.emit();
	};

	const gate = new TermiusGate({
		config: () => config,
		grants,
		hosts,
		saveHostLevel: (key, level, label) => update((current) => markKnown(updateHost(current, key, { level }, label), [key])),
		grantsChanged,
		record: (entry) => {
			try {
				appendActivity(entry);
			} catch {
				// The log is a convenience; a full disk must not block the call.
			}
			changed.emit();
		},
		activeChanged: (labels) => {
			activeHosts = labels;
			updateFooter();
		},
	});

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
				if (data.ok && data.logged_in && !hosts.loading) void hosts.refresh(false).finally(() => changed.emit());
			})
			.catch((error: Error) => {
				account = { loading: false, data: { ok: false, error: error.message } };
			})
			.finally(() => changed.emit());
	};

	pi.on("session_start", async (event, ctx) => {
		statusCtx = ctx;
		config = readConfig();
		// Grants survive /reload only (session-state.ts).
		if ((event as { reason?: string }).reason === "reload") grants.restore(lastSnapshot(ctx.sessionManager?.getBranch?.() ?? []));
		else grants.clear();
		activeHosts = [];
		updateFooter();
		// Another session may have turned the server on or off since this one loaded.
		if (!isEnabled(config)) unregister();
		else if (!registered && installState() !== "missing") register();
		if (isEnabled(config) && installState() === "outdated") {
			ctx.ui.setStatus(UPDATE_STATUS_KEY, "termius: updating…");
			reinstall()
				.then(() => ctx.ui.notify("termius: MCP server updated", "info"))
				.catch((error: Error) => ctx.ui.notify(`termius: ${messages().updateFailed(error.message)}`, "error"))
				.finally(() => ctx.ui.setStatus(UPDATE_STATUS_KEY, undefined));
		} else {
			removeOldEnvironments();
		}
	});

	// ── tool gate ───────────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		const verdict = guardToolCall(event.toolName, event.input);
		if (verdict.block) return { block: true, reason: verdict.reason };
		statusCtx = ctx;
		config = readConfig();
		return gate.onToolCall(event as never, ctx);
	});

	pi.on("tool_result", async (event) => gate.onToolResult(event as never) as never);

	pi.on("tool_execution_end", async (event) => {
		gate.forget((event as { toolCallId: string }).toolCallId);
	});

	// ── actions (each returns what happened; the menu shows it, typed commands notify it) ──

	/**
	 * Tell the model the account changed. A "Not signed in" status from
	 * earlier in the conversation would otherwise read as current. Hidden from
	 * the transcript; sent with the next prompt.
	 */
	const noteAccountChange = (text: string) => {
		pi.sendMessage(
			{ customType: "termius-account", content: `[termius] ${text} Earlier termius status results in this conversation are out of date; call status again before relying on them.`, display: false },
			{ deliverAs: "nextTurn" },
		);
	};

	const loginNotice = (response: LoginResponse): Notice => {
		const m = messages();
		if (!response.ok) return { text: m.signInFailed(String(response.error ?? response.code)), type: "error" };
		// The running server re-reads the session from disk on its next call
		// (Runtime.refresh); this only starts it if it was not registered yet.
		register();
		noteAccountChange(`The user signed in to Termius as ${String(response.username ?? "?")}.`);
		void hosts.refresh(false).finally(() => changed.emit());
		// login-json pulls the inventory right after signing in; a failed pull
		// leaves the sign-in valid and is retried by the next host call.
		return response.synced === true
			? { text: m.signedInSynced(String(response.username ?? "?"), Number(response.hosts ?? 0)), type: "success" }
			: { text: m.signedInSyncFailed(String(response.username ?? "?"), String(response.sync_error ?? "?")), type: "warning" };
	};

	/** Run a login request, asking for an authenticator code or app approval when needed. */
	const loginWithRetries = async (ctx: ExtensionCommandContext, request: Record<string, unknown>): Promise<Notice | undefined> => {
		const m = messages();
		let response = await loginJson(request);
		for (let attempt = 0; attempt < 3 && !response.ok; attempt++) {
			if (response.code === "otp_required") {
				const otp = await promptMaskedWithUi(ctx, m.otpTitle, m.otpHint);
				if (!otp) return undefined;
				response = await loginJson({ ...request, otp: otp.trim() });
			} else if (response.code === "approve_required") {
				const next = await showMenu(ctx, () => ({
					title: m.approveTitle,
					status: [m.approveStatus],
					items: [{ value: "retry", label: m.approveRetry }],
					cancelLabel: m.cancel,
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
		const m = messages();
		if (ctx.mode !== "tui") return { text: m.signInTui, type: "warning" };
		const method = await chooseValue(
			ctx,
			m.signInWith,
			[
				{ value: "email", label: m.emailPassword },
				{ value: "google", label: m.google, description: m.googleHelp },
			],
			"email",
		);
		if (!method) return undefined;
		if (method === "google") {
			const start = await loginJson({ action: "google_url" });
			if (!start.ok) return loginNotice(start);
			await ctx.ui.editor(m.googleEditor, String(start.url));
			const callback = await promptMaskedWithUi(ctx, m.callbackTitle, "termius://app/continue-sso?...");
			if (!callback) return undefined;
			const password = await promptMaskedWithUi(ctx, m.vaultPasswordTitle, m.vaultPasswordHint);
			if (!password) return undefined;
			return loginWithRetries(ctx, { action: "google", callback_url: callback.trim(), password });
		}
		const username = await ctx.ui.input(m.emailTitle, "you@example.com");
		if (!username) return undefined;
		const password = await promptMaskedWithUi(ctx, m.passwordTitle, m.passwordHint);
		if (!password) return undefined;
		return loginWithRetries(ctx, { action: "email", username: username.trim(), password });
	};

	/** Install uv when neither uv nor Python exists (asks first), then the server. */
	const setup = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const m = messages();
		if (!findUv() && !findPython()) {
			const installer = uvInstallerCommand();
			const ok =
				ctx.hasUI &&
				(await showMenu(ctx, () => ({
					title: m.uvTitle,
					status: [m.uvStatus, installer.display],
					items: [{ value: "yes", label: m.uvInstall }],
					cancelLabel: m.cancel,
				}))) === "yes";
			if (!ok) return { text: m.uvFirst(installer.display), type: "warning" };
			await installUv();
		}
		try {
			await reinstall();
		} catch (error) {
			return { text: m.installFailed((error as Error).message), type: "error" };
		}
		refreshAccount();
		return { text: m.installed, type: "success" };
	};

	const sync = async (): Promise<Notice> => {
		const m = messages();
		if (installState() === "missing") return { text: m.notInstalled, type: "warning" };
		const response = await loginJson({ action: "sync" });
		if (!response.ok) return { text: m.syncFailed(String(response.error ?? response.code)), type: "error" };
		register(); // starts it if needed; a running server re-reads the cache on its next call
		void hosts.refresh(false).finally(() => changed.emit());
		return { text: m.synced(Number(response.hosts ?? 0)), type: "success" };
	};

	const setEnabled = async (enabled: boolean): Promise<Notice> => {
		const m = messages();
		if (isEnabled(config) !== enabled) {
			update((current) => {
				const next: TermiusConfig = { ...current };
				if (enabled) delete next.enabled;
				else next.enabled = false;
				return next;
			});
		}
		if (!enabled) {
			unregister();
			return { text: m.turnedOff, type: "info" };
		}
		if (installState() === "missing") return { text: m.turnedOnPendingInstall, type: "info" };
		// Sessions skip the update reinstall while it is off; catch up now.
		if (installState() === "outdated") {
			try {
				await reinstall();
			} catch (error) {
				return { text: m.updateFailed((error as Error).message), type: "error" };
			}
		} else if (!registered) register();
		return { text: m.turnedOn, type: "success" };
	};

	const applyLevel = (level: GlobalLevel): Notice => {
		const m = messages();
		update((current) => ({ ...current, mode: level }));
		return { text: m.levelSet(m.levelName(level), m.levelHelp(level)), type: level === "trusted" ? "warning" : "success" };
	};

	const chooseLevel = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const m = messages();
		const level = await chooseValue(
			ctx,
			m.levelTitle,
			GLOBAL_LEVELS.map((value) => ({ value, label: m.levelName(value), description: m.levelHelp(value) })),
			config.mode,
		);
		const parsed = parseGlobalLevel(level);
		return parsed && parsed !== config.mode ? applyLevel(parsed) : undefined;
	};

	const applyRoute = (mode: string): Notice => {
		const m = messages();
		if (!isRouteMode(mode)) return { text: m.routeUsage(ROUTE_MODES.join(", ")), type: "warning" };
		update((current) => {
			const next: TermiusConfig = { ...current, route: mode };
			if (mode === "termius") delete next.route;
			return next;
		});
		void hosts.refresh(false).finally(() => changed.emit());
		return { text: m.routeSet(m.routeName(mode)), type: "success" };
	};

	const chooseRoute = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const m = messages();
		const current = globalRoute(config);
		const mode = await chooseValue(
			ctx,
			m.routeTitle,
			ROUTE_MODES.map((value) => ({ value, label: m.routeName(value), description: `${m.routeHelp(value)} ${m.routeNoFallback}` })),
			current,
		);
		return mode && mode !== current ? applyRoute(mode) : undefined;
	};

	const proxyKind = (): "system" | "direct" | "url" => (config.proxy === undefined ? "system" : config.proxy === "off" ? "direct" : "url");

	const applyProxy = (value: string): Notice => {
		const m = messages();
		if (value !== "system" && value !== "off" && value !== "direct") {
			const error = proxyUrlError(value);
			if (error) return { text: error, type: "warning" };
		}
		update((current) => {
			const next: TermiusConfig = { ...current };
			if (value === "system") {
				delete next.proxy;
				delete next.proxyBypass;
			} else if (value === "off" || value === "direct") {
				next.proxy = "off";
				delete next.proxyBypass;
			} else {
				next.proxy = value;
			}
			return next;
		});
		// The proxy reaches the server through its environment: restart it.
		if (installState() !== "missing") register();
		void hosts.refresh(false).finally(() => changed.emit());
		return { text: m.proxySet(describeProxy(config)), type: "success" };
	};

	const chooseProxy = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const m = messages();
		const current = proxyKind() === "direct" ? "off" : proxyKind();
		const choice = await chooseValue(
			ctx,
			m.proxyTitle,
			[
				{ value: "system", label: m.proxySystem, description: m.proxySystemHelp },
				{ value: "url", label: m.proxyUrl, description: m.proxyUrlHelp },
				{ value: "off", label: m.proxyOff },
			],
			current,
			[m.proxyNow(describeProxy(config)), m.proxyScope],
		);
		if (!choice) return undefined;
		if (choice !== "url") return choice === current ? undefined : applyProxy(choice);
		const entered = await promptMaskedWithUi(ctx, m.proxyUrlTitle, m.proxyUrlPlaceholder);
		return entered?.trim() ? applyProxy(entered.trim()) : undefined;
	};

	const setHostLevel = async (name: string | undefined, value: string | undefined): Promise<Notice> => {
		const m = messages();
		if (!name || !value) return { text: m.hostUsage, type: "warning" };
		const level = value === "inherit" ? undefined : value === "dangerously" ? "trusted" : value;
		if (level !== undefined && !isLevel(level)) return { text: m.levelUsage(["inherit", "off", ...GLOBAL_LEVELS].join(", ")), type: "warning" };
		let rows = hosts.resolve(name);
		if (rows.length === 0) {
			await hosts.refresh(false);
			rows = hosts.resolve(name);
		}
		if (rows.length === 0) return { text: m.hostNotFound(name), type: "warning" };
		if (rows.length > 1) return { text: m.hostAmbiguous(name), type: "warning" };
		const row = rows[0]!;
		update((current) => markKnown(updateHost(current, row.cloud_id, { level: level as Level | undefined }, row.label), [row.cloud_id]));
		return { text: m.hostLevelSet(row.label, level ? m.levelName(level as Level) : m.inherit), type: "success" };
	};

	const logout = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const m = messages();
		if (installState() === "missing") return undefined;
		if (ctx.hasUI) {
			const sure = await showMenu(ctx, () => ({
				title: m.signOutTitle,
				status: [m.logoutHelp],
				items: [{ value: "yes", label: m.signOutConfirm }],
				cancelLabel: m.cancel,
			}));
			if (sure !== "yes") return undefined;
		}
		const response = await loginJson({ action: "logout" });
		register();
		if (response.ok) {
			hosts.clear();
			noteAccountChange("The user signed out of Termius.");
		}
		return response.ok ? { text: m.signedOutNotice, type: "info" } : { text: m.signOutFailed(String(response.error)), type: "error" };
	};

	// ── the menu ────────────────────────────────────────────────────────────

	const signedIn = () => account.data?.ok === true && account.data.logged_in === true;

	const statusLines = (): string[] => {
		const m = messages();
		const state = installState();
		const on = isEnabled(config);
		const lines: string[] = [];
		if (installing) lines.push(m.serverInstalling(installStep ?? ""));
		else if (installError) lines.push(m.serverInstallFailed(installError));
		else if (state === "missing") lines.push(m.serverMissing);
		else if (state === "outdated") lines.push(m.serverOutdated);
		if (state === "missing" || installing) {
			lines.push(m.mcpState(on));
			return lines;
		}
		const data = account.data;
		if (account.loading && !data) lines.push(m.accountChecking);
		else if (signedIn()) {
			const count = hosts.current?.rows.length ?? Number(data?.hosts ?? 0);
			// Level and route are items of their own, with their values beside them.
			const vault = data?.vault_remembered ? "" : ` · ${m.vaultNotRemembered}`;
			lines.push(`${m.signedIn(String(data?.username), count, ago(data?.last_synced))} · ${m.mcpOnOff(on)}${vault}`);
		} else if (data?.ok) lines.push(m.signedOut(on));
		else if (data) lines.push(m.accountError(String(data.error ?? data.code ?? "unknown")));
		return lines;
	};

	const onOffItem = (): MenuItem => {
		const m = messages();
		return isEnabled(config)
			? { value: "disable", label: m.itemDisable, description: m.disableHelp }
			: { value: "enable", label: m.itemEnable, description: m.enableHelp };
	};

	const activityItem = (): MenuItem | undefined => {
		const m = messages();
		const entries = readActivity();
		if (entries.length === 0) return undefined;
		const today = activityToday(entries);
		return { value: "activity", label: m.itemActivity, hint: m.activityHint(today.total, today.denied), description: m.activityHelp };
	};

	const menuItems = (): MenuItem[] => {
		const m = messages();
		const state = installState();
		if (state === "missing" || installing) {
			return installing ? [onOffItem()] : [{ value: "setup", label: m.itemSetup, description: m.setupHelp }, onOffItem()];
		}
		if (!signedIn()) {
			if (account.loading && !account.data) return [onOffItem()];
			const items: MenuItem[] = [{ value: "login", label: m.itemLogin, description: m.loginHelp }];
			const activity = activityItem();
			if (activity) items.push(activity);
			items.push(onOffItem());
			return items;
		}
		const list = hosts.current;
		const count = list?.rows.length ?? Number(account.data?.hosts ?? 0);
		const fresh = list && config.knownHosts ? list.rows.filter((row) => !config.knownHosts!.includes(row.cloud_id)).length : 0;
		const items: MenuItem[] = [
			{ value: "hosts", label: m.itemHosts, hint: m.hostsHint(count, fresh, grants.count), description: m.hostsHelp },
			{ value: "mode", label: m.itemLevel, hint: m.levelName(config.mode), description: m.levelHelp(config.mode) },
			{ value: "route", label: m.itemRoute, hint: m.routeName(globalRoute(config)), description: `${m.routeHelp(globalRoute(config))} ${m.routeNoFallback}` },
			{ value: "proxy", label: m.itemProxy, hint: m.proxyHint(proxyKind()), description: describeProxy(config) },
		];
		const activity = activityItem();
		if (activity) items.push(activity);
		items.push({ value: "logout", label: m.itemLogout, description: m.logoutHelp }, onOffItem());
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
					notice = { text: messages().installed, type: "success" };
					refreshAccount();
				})
				.catch(() => {});
		}
		refreshAccount();
		for (;;) {
			const choice = await showMenu(
				ctx,
				() => ({ title: messages().title, status: statusLines(), notice, items: menuItems(), selected, cancelLabel: messages().close }),
				changed.subscribe,
			);
			if (!choice) return;
			selected = choice;
			notice = undefined;
			try {
				const result = await runAction(ctx, choice);
				if (result) notice = result;
			} catch (error) {
				notice = { text: (error as Error).message, type: "error" };
			}
			if (choice === "login" || choice === "logout") refreshAccount();
		}
	};

	const runAction = async (ctx: ExtensionCommandContext, action: string, args: string[] = []): Promise<Notice | undefined> => {
		const m = messages();
		const [value, second] = args;
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
			case "hosts":
				await runHostsMenu(ctx, {
					config: () => config,
					update,
					grants,
					grantsChanged,
					hosts,
					test: (key) => loginJson({ action: "test", host: key }, serverEnv()),
					changed,
				});
				return undefined;
			case "activity":
				return runActivityView(ctx, {
					read: readActivity,
					clear: () => {
						clearActivity();
						changed.emit();
					},
				});
			case "mode": {
				if (value === undefined) return chooseLevel(ctx);
				const level = parseGlobalLevel(value);
				return level ? applyLevel(level) : { text: m.levelUsage(GLOBAL_LEVELS.join(", ")), type: "warning" };
			}
			case "route":
				return value === undefined ? chooseRoute(ctx) : applyRoute(value);
			case "proxy":
				return value === undefined ? chooseProxy(ctx) : applyProxy(value);
			case "host":
				return setHostLevel(value, second);
			default:
				return { text: m.unknownSubcommand(action, SUBCOMMANDS.join(" | ")), type: "warning" };
		}
	};

	/** `/termius status` outside the menu, e.g. in print mode. */
	const printStatus = async (ctx: ExtensionCommandContext) => {
		if (installState() !== "missing") account = { loading: false, data: await loginJson({ action: "status" }) };
		const m = messages();
		ctx.ui.notify(`termius\n${statusLines().join("\n")}\n${m.itemProxy}: ${describeProxy(config)}`, "info");
	};

	pi.registerCommand("termius", {
		description:
			"Termius SSH via MCP: hosts, access levels, routes, proxy, activity, sign-in, on/off (subcommands: login, logout, enable, disable, mode, route, proxy, host, status, sync, setup)",
		getArgumentCompletions: (prefix) => {
			const [first, second] = prefix.trimStart().split(/\s+/);
			if (first === "mode" && second !== undefined) {
				return GLOBAL_LEVELS.filter((level) => level.startsWith(second)).map((level) => ({ value: `mode ${level}`, label: level }));
			}
			if (first === "route" && second !== undefined) {
				return ROUTE_MODES.filter((mode) => mode.startsWith(second)).map((mode) => ({ value: `route ${mode}`, label: mode }));
			}
			const matches = SUBCOMMANDS.filter((command) => command.startsWith(first ?? ""));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const sub = words[0];
			statusCtx = ctx;
			config = readConfig();
			try {
				if (!sub) {
					if (ctx.hasUI) await runMenu(ctx);
					else await printStatus(ctx);
					return;
				}
				if (sub === "status") return await printStatus(ctx);
				const result = await runAction(ctx, sub, words.slice(1));
				if (result) ctx.ui.notify(`termius: ${result.text}`, result.type === "success" ? "info" : result.type);
			} catch (error) {
				ctx.ui.notify(`termius: ${(error as Error).message}`, "error");
			}
		},
	});
}
