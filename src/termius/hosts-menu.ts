/**
 * /termius → Hosts: the host list, a host's detail page, and the batch editor.
 *
 * Levels and routes are saved in config.json (the server picks routes up on
 * its next call); temporary levels and session allows live in the session
 * (session-state.ts). Setting any level, "follow global" included, clears a
 * host's "new" mark. Route changes reload the list, since the server
 * resolves routes (jump hosts, proxies) for it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseValue, type MenuItem, type Notice, type Signal, showMenu } from "../preset-menu.ts";
import { promptMaskedWithUi } from "../preset-ui.ts";
import { globalRoute, markKnown, ROUTE_MODES, type RouteMode, type TermiusConfig, updateHost } from "./config.ts";
import { routeColumn, routeSummary, viaText } from "./format.ts";
import type { HostIndex, HostRow } from "./host-index.ts";
import { type HostListRow, showHostList, type Tone } from "./host-list.ts";
import { effectiveLevel, isLevel, LEVELS, type Level } from "./levels.ts";
import { type Messages, messages } from "./messages.ts";
import { proxyUrlError, redactProxyUrl } from "./proxy.ts";
import type { SessionGrants } from "./session-state.ts";

export interface HostsMenuDeps {
	config(): TermiusConfig;
	/** Re-read, change, and save config.json; the deps' config() returns the result afterwards. */
	update(change: (config: TermiusConfig) => TermiusConfig): void;
	grants: SessionGrants;
	grantsChanged(): void;
	hosts: HostIndex;
	/** login-json `test` for a cloud id. */
	test(key: string): Promise<Record<string, unknown>>;
	changed: Signal;
}

type Ctx = Pick<ExtensionContext, "mode" | "ui">;

export const LEVEL_TONE: Record<Level, Tone> = { off: "error", "read-only": "warning", review: "accent", auto: undefined, trusted: "success" };

function levelOptions(m: Messages, globalName: string) {
	return [
		{ value: "inherit", label: m.inherit, description: m.inheritHelp(globalName) },
		...LEVELS.map((level) => ({ value: level, label: m.levelName(level), description: m.levelHelp(level) })),
	];
}

function routeOptions(m: Messages, globalName: string) {
	return [
		{ value: "inherit", label: m.inherit, description: m.inheritHelp(globalName) },
		...ROUTE_MODES.map((mode) => ({ value: mode, label: m.routeName(mode), description: `${m.routeHelp(mode)} ${m.routeNoFallback}` })),
	];
}

function isNew(config: TermiusConfig, key: string): boolean {
	return config.knownHosts !== undefined && !config.knownHosts.includes(key);
}

/** Display rows for the host list. */
export function hostListRows(deps: Pick<HostsMenuDeps, "config" | "grants" | "hosts">, m: Messages = messages()): HostListRow[] {
	const config = deps.config();
	return (deps.hosts.current?.rows ?? []).map((row) => {
		const key = row.cloud_id;
		const own = config.hosts?.[key]?.level;
		const temporary = deps.grants.temporaryLevel(key);
		const jumpFor = deps.hosts.jumpHostFor(key);
		const marks: HostListRow["marks"] = [];
		if (isNew(config, key)) marks.push({ text: m.markNew, tone: "accent" });
		if (temporary) marks.push({ text: m.markTemporary(m.levelName(temporary)), tone: "warning" });
		if (deps.grants.isAllowed(key)) marks.push({ text: m.markSession, tone: "success" });
		if (jumpFor > 0) marks.push({ text: m.markJumpFor(jumpFor) });
		const route = routeColumn(row.route, m);
		return {
			key,
			label: row.label,
			address: row.address,
			route,
			routeTone: row.route.error ? "error" : row.route.source === "host" ? "accent" : undefined,
			level: own ? m.levelName(own) : undefined,
			levelTone: own ? LEVEL_TONE[own] : undefined,
			marks,
			search: [row.label, row.address, row.group ?? "", row.username ?? "", ...row.tags, route, own ? m.levelName(own) : "", ...marks.map((mark) => mark.text)]
				.join(" ")
				.toLowerCase(),
		};
	});
}

export async function runHostsMenu(ctx: Ctx, deps: HostsMenuDeps): Promise<void> {
	let selectedKey: string | undefined;
	if (!deps.hosts.loading) deps.hosts.refresh(true).finally(() => deps.changed.emit());
	for (;;) {
		const result = await showHostList(
			ctx,
			() => {
				const m = messages();
				const config = deps.config();
				const list = deps.hosts.current;
				const rows = hostListRows(deps, m);
				let placeholder: string | undefined;
				if (!list) placeholder = deps.hosts.error ? m.hostsLoadFailed(deps.hosts.error) : m.hostsLoading;
				else if (rows.length === 0) placeholder = m.hostsEmpty;
				return {
					title: m.hostsTitle(rows.length),
					status: [m.hostsGlobal(m.levelName(config.mode), m.routeName(globalRoute(config)))],
					notice: list?.syncError ? { text: m.hostsSyncFailed(list.syncError), tone: "warning" } : undefined,
					rows,
					placeholder,
					labels: {
						filter: m.filter,
						filterHint: m.filterHint,
						noMatch: m.hostsNoMatch,
						legend: m.followsGlobal,
						keys: m.hostKeys,
						keysSelected: m.hostKeysSelected,
						more: m.hostsMore,
					},
					selectedKey,
				};
			},
			deps.changed.subscribe,
		);
		if (!result) return;
		if (result.action === "open") {
			selectedKey = result.key;
			await hostDetail(ctx, deps, result.key);
		} else {
			await batchEdit(ctx, deps, result.keys);
		}
	}
}

function labelOf(deps: HostsMenuDeps, key: string): string {
	return deps.hosts.find(key)?.label ?? deps.config().hosts?.[key]?.label ?? key;
}

function testNotice(response: Record<string, unknown>, label: string, m: Messages): Notice {
	const stages = Array.isArray(response.stages) ? (response.stages as Record<string, unknown>[]) : [];
	const lines = stages.map((stage) =>
		m.testStage(String(stage.label), `${String(stage.address)}:${String(stage.port)}`, viaText(String(stage.via), m), Number(stage.seconds).toFixed(2)),
	);
	if (response.ok === true) return { text: [m.testOk(Number(response.seconds).toFixed(2)), ...lines].join("\n"), type: "success" };
	const failed = (response.failed ?? {}) as Record<string, unknown>;
	// No failed hop: the route could not even be planned (a missing proxy, a jump host gone).
	const where = failed.label ? String(failed.label) : label;
	return { text: [m.testFailed(where, String(response.error ?? response.code ?? "")), ...lines].join("\n"), type: "error" };
}

/** Lines describing one host, for its detail page. */
function detailStatus(deps: HostsMenuDeps, key: string, row: HostRow | undefined, m: Messages): string[] {
	const config = deps.config();
	const lines: string[] = [];
	if (row) {
		lines.push(m.detailAddress(row.address, row.port, row.username));
		if (row.tags.length > 0) lines.push(m.detailTags(row.tags.join(", ")));
		const mode = `${m.routeName(row.route.mode)}${row.route.source === "global" ? ` (${m.inherit})` : ""}`;
		lines.push(row.route.error ? m.detailRouteError(row.route.error) : m.detailRoute(`${mode} · ${routeSummary(row.route, m)}`));
	}
	const effective = effectiveLevel({
		globalLevel: config.mode,
		hostLevel: config.hosts?.[key]?.level,
		temporaryLevel: deps.grants.temporaryLevel(key),
	});
	lines.push(m.detailLevel(m.levelName(effective.level), m.levelSource(effective.source)));
	if (deps.grants.isAllowed(key)) lines.push(m.detailSession);
	const jumpFor = deps.hosts.jumpHostFor(key);
	if (jumpFor > 0) lines.push(m.detailJumpFor(jumpFor));
	if (isNew(config, key)) lines.push(m.detailNew);
	return lines;
}

function usesProxy(mode: RouteMode, row: HostRow | undefined): boolean {
	return mode === "proxy" || mode === "termius-proxy" || (row?.route.proxy ?? null) !== null;
}

async function hostDetail(ctx: Ctx, deps: HostsMenuDeps, key: string): Promise<void> {
	let notice: Notice | undefined;
	let selected: string | undefined;
	for (;;) {
		const choice = await showMenu(
			ctx,
			() => {
				const m = messages();
				const config = deps.config();
				const row = deps.hosts.find(key);
				const own = config.hosts?.[key];
				const temporary = deps.grants.temporaryLevel(key);
				const routeMode = own?.route ?? globalRoute(config);
				const items: MenuItem[] = [
					{
						value: "level",
						label: m.itemHostLevel,
						hint: own?.level ? m.levelName(own.level) : `${m.inherit} (${m.levelName(config.mode)})`,
						description: own?.level ? m.levelHelp(own.level) : m.inheritHelp(m.levelName(config.mode)),
					},
					{
						value: "route",
						label: m.itemHostRoute,
						hint: own?.route ? m.routeName(own.route) : `${m.inherit} (${m.routeName(globalRoute(config))})`,
						description: `${m.routeHelp(routeMode)} ${m.routeNoFallback}`,
					},
				];
				if (usesProxy(routeMode, row) || own?.proxy) {
					items.push({ value: "proxy", label: m.itemHostProxy, hint: own?.proxy ? redactProxyUrl(own.proxy) : m.hostProxyHint(false), description: m.hostProxyHelp });
				}
				items.push({ value: "temporary", label: m.itemTemporary, hint: temporary ? m.levelName(temporary) : m.temporaryNone, description: m.temporaryHelp });
				if (deps.grants.isAllowed(key)) items.push({ value: "revoke", label: m.itemRevoke, description: m.revokeHelp });
				if (row) items.push({ value: "test", label: m.itemTest, description: m.testHelp });
				return { title: labelOf(deps, key), status: detailStatus(deps, key, row, m), notice, items, selected, cancelLabel: m.back };
			},
			deps.changed.subscribe,
		);
		if (!choice) return;
		selected = choice;
		notice = await detailAction(ctx, deps, key, choice, (pending) => {
			notice = pending;
			deps.changed.emit();
		});
	}
}

async function detailAction(ctx: Ctx, deps: HostsMenuDeps, key: string, action: string, progress: (notice: Notice) => void): Promise<Notice | undefined> {
	const m = messages();
	const config = deps.config();
	const label = labelOf(deps, key);
	const own = config.hosts?.[key];
	switch (action) {
		case "level": {
			const value = await chooseValue(ctx, m.hostLevelTitle(label), levelOptions(m, m.levelName(config.mode)), own?.level ?? "inherit");
			if (!value) return undefined;
			setLevels(deps, [key], value);
			return undefined;
		}
		case "route": {
			const value = await chooseValue(ctx, m.hostRouteTitle(label), routeOptions(m, m.routeName(globalRoute(config))), own?.route ?? "inherit");
			if (!value) return undefined;
			setRoutes(deps, [key], value);
			return undefined;
		}
		case "proxy": {
			const entered = await promptMaskedWithUi(ctx as never, m.hostProxyTitle(label), m.proxyUrlPlaceholder);
			if (entered === undefined) return undefined;
			const url = entered.trim();
			if (url) {
				const error = proxyUrlError(url);
				if (error) return { text: error, type: "warning" };
			}
			deps.update((current) => updateHost(current, key, { proxy: url || undefined }, label));
			void deps.hosts.refresh(false).finally(() => deps.changed.emit());
			return undefined;
		}
		case "temporary": {
			const value = await chooseValue(
				ctx,
				m.temporaryTitle(label),
				[{ value: "none", label: m.temporaryClear }, ...LEVELS.map((level) => ({ value: level, label: m.levelName(level), description: m.levelHelp(level) }))],
				deps.grants.temporaryLevel(key) ?? "none",
				[m.temporaryHelp],
			);
			if (!value) return undefined;
			setTemporary(deps, [key], value);
			return undefined;
		}
		case "revoke":
			deps.grants.revoke(key);
			deps.grantsChanged();
			return undefined;
		case "test":
			progress({ text: m.testing, type: "info" });
			return testNotice(await deps.test(key), label, m);
		default:
			return undefined;
	}
}

function setLevels(deps: HostsMenuDeps, keys: readonly string[], value: string): void {
	const level = isLevel(value) ? value : undefined;
	deps.update((config) => {
		let next = config;
		for (const key of keys) next = updateHost(next, key, { level }, deps.hosts.find(key)?.label);
		return markKnown(next, keys);
	});
}

function setRoutes(deps: HostsMenuDeps, keys: readonly string[], value: string): void {
	const route = (ROUTE_MODES as readonly string[]).includes(value) ? value : undefined;
	deps.update((config) => {
		let next = config;
		for (const key of keys) next = updateHost(next, key, { route }, deps.hosts.find(key)?.label);
		return next;
	});
	void deps.hosts.refresh(false).finally(() => deps.changed.emit());
}

function setTemporary(deps: HostsMenuDeps, keys: readonly string[], value: string): void {
	for (const key of keys) deps.grants.setTemporary(key, isLevel(value) ? value : undefined);
	deps.grantsChanged();
}

async function batchEdit(ctx: Ctx, deps: HostsMenuDeps, keys: string[]): Promise<void> {
	let notice: Notice | undefined;
	let selected: string | undefined;
	for (;;) {
		const choice = await showMenu(
			ctx,
			() => {
				const m = messages();
				const items: MenuItem[] = [
					{ value: "level", label: m.itemHostLevel },
					{ value: "route", label: m.itemHostRoute },
					{ value: "temporary", label: m.itemTemporary, description: m.temporaryHelp },
				];
				if (keys.some((key) => deps.grants.isAllowed(key))) items.push({ value: "revoke", label: m.itemRevokeAll, description: m.revokeHelp });
				return {
					title: m.batchTitle(keys.length),
					status: [m.batchStatus(keys.map((key) => labelOf(deps, key)).join(", "))],
					notice,
					items,
					selected,
					cancelLabel: m.back,
				};
			},
			deps.changed.subscribe,
		);
		if (!choice) return;
		selected = choice;
		const m = messages();
		const config = deps.config();
		let value: string | undefined;
		switch (choice) {
			case "level":
				value = await chooseValue(ctx, m.batchLevelTitle(keys.length), levelOptions(m, m.levelName(config.mode)), undefined);
				if (value) setLevels(deps, keys, value);
				break;
			case "route":
				value = await chooseValue(ctx, m.batchRouteTitle(keys.length), routeOptions(m, m.routeName(globalRoute(config))), undefined);
				if (value) setRoutes(deps, keys, value);
				break;
			case "temporary":
				value = await chooseValue(
					ctx,
					m.batchTemporaryTitle(keys.length),
					[{ value: "none", label: m.temporaryClear }, ...LEVELS.map((level) => ({ value: level, label: m.levelName(level), description: m.levelHelp(level) }))],
					undefined,
					[m.temporaryHelp],
				);
				if (value) setTemporary(deps, keys, value);
				break;
			case "revoke":
				for (const key of keys) deps.grants.revoke(key);
				deps.grantsChanged();
				value = "revoke";
				break;
		}
		if (value) notice = { text: m.batchDone(keys.length), type: "success" };
	}
}
