/**
 * The Termius MCP server's config.json, shared by /termius and the server.
 *
 * pi writes it; the server reads the parts it enforces (disabled hosts,
 * routes, host proxy URLs) through TERMIUS_MCP_POLICY on every call
 * (vendor/termius-mcp/termius/policy.py). The design is in
 * docs/termius-design.md.
 *
 *   mode        global access level (read-only | review | auto | trusted);
 *               "dangerously" from older versions reads as trusted
 *   route       global route mode (absent = termius)
 *   proxy       absent = system proxy variables; "off" = none; else a URL
 *   proxyBypass hosts that bypass a proxy URL
 *   enabled     false = the server is off in every session
 *   hosts       per host, keyed by Termius cloud id: label (display only),
 *               level, route, proxy
 *   knownHosts  cloud ids already seen; hosts outside it are marked new
 *
 * Writes replace the file atomically (the server may read it at any time)
 * and keep it 0600, because proxy URLs can carry passwords. Every change
 * goes through updateConfig, which re-reads the file first, so two pi
 * windows do not undo each other's changes.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "./install.ts";
import { DEFAULT_GLOBAL_LEVEL, type GlobalLevel, type Level, parseGlobalLevel, parseLevel } from "./levels.ts";
import type { ProxySettings } from "./proxy.ts";

export const ROUTE_MODES = ["termius", "termius-proxy", "direct", "proxy"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];
export const DEFAULT_ROUTE: RouteMode = "termius";

export function isRouteMode(value: unknown): value is RouteMode {
	return typeof value === "string" && (ROUTE_MODES as readonly string[]).includes(value);
}

export interface HostSettings {
	/** Label when last saved, for display while the host list is not loaded. */
	label?: string;
	/** Absent = follow the global level. */
	level?: Level;
	/** Absent = follow the global route. */
	route?: RouteMode;
	/** Proxy URL for this host; replaces the proxy setting wherever its route uses a proxy. */
	proxy?: string;
}

export interface TermiusConfig extends ProxySettings {
	mode: GlobalLevel;
	/** Absent = termius. */
	route?: RouteMode;
	/** `false` = the MCP server is not registered in any session. Absent = on. */
	enabled?: false;
	hosts?: Record<string, HostSettings>;
	/** Absent until the host list was first loaded; then the baseline for "new". */
	knownHosts?: string[];
}

export function configPath(): string {
	return join(installDir(), "config.json");
}

export function isEnabled(config: TermiusConfig): boolean {
	return config.enabled !== false;
}

export function globalRoute(config: TermiusConfig): RouteMode {
	return config.route ?? DEFAULT_ROUTE;
}

function parseHosts(value: unknown): Record<string, HostSettings> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const hosts: Record<string, HostSettings> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		const settings: HostSettings = {};
		if (typeof entry.label === "string") settings.label = entry.label;
		const level = parseLevel(entry.level);
		if (level) settings.level = level;
		if (isRouteMode(entry.route)) settings.route = entry.route;
		if (typeof entry.proxy === "string" && entry.proxy.trim()) settings.proxy = entry.proxy.trim();
		hosts[key] = settings;
	}
	return hosts;
}

/** Parse a config object; unknown or invalid fields are dropped. */
export function parseConfig(data: unknown): TermiusConfig {
	const source = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const config: TermiusConfig = { mode: parseGlobalLevel(source.mode) ?? DEFAULT_GLOBAL_LEVEL };
	if (isRouteMode(source.route) && source.route !== DEFAULT_ROUTE) config.route = source.route;
	if (typeof source.proxy === "string" && source.proxy.trim()) config.proxy = source.proxy.trim();
	if (Array.isArray(source.proxyBypass)) config.proxyBypass = source.proxyBypass.filter((item): item is string => typeof item === "string");
	if (source.enabled === false) config.enabled = false;
	const hosts = parseHosts(source.hosts);
	if (hosts && Object.keys(hosts).length > 0) config.hosts = hosts;
	if (Array.isArray(source.knownHosts)) config.knownHosts = source.knownHosts.filter((item): item is string => typeof item === "string");
	return config;
}

export function readConfig(): TermiusConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		return parseConfig({});
	}
}

export function writeConfig(config: TermiusConfig): void {
	const path = configPath();
	mkdirSync(installDir(), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	// 0600: a proxy URL can carry a password.
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

/** Re-read the file, apply `change`, write it back; returns the saved config. */
export function updateConfig(change: (config: TermiusConfig) => TermiusConfig | void): TermiusConfig {
	const current = readConfig();
	const next = change(current) ?? current;
	writeConfig(next);
	return next;
}

/** Change one host's settings; an empty entry is removed. `label` refreshes the display snapshot. */
export function updateHost(config: TermiusConfig, key: string, change: Partial<Record<keyof HostSettings, string | undefined>>, label?: string): TermiusConfig {
	const hosts = { ...(config.hosts ?? {}) };
	const entry: HostSettings = { ...(hosts[key] ?? {}) };
	for (const [field, value] of Object.entries(change) as [keyof HostSettings, string | undefined][]) {
		if (value === undefined) delete entry[field];
		else (entry as Record<string, string>)[field] = value;
	}
	if (label) entry.label = label;
	const meaningful = entry.level !== undefined || entry.route !== undefined || entry.proxy !== undefined;
	if (meaningful) hosts[key] = entry;
	else delete hosts[key];
	const next: TermiusConfig = { ...config, hosts };
	if (Object.keys(hosts).length === 0) delete next.hosts;
	return next;
}

/** Mark hosts as seen (clears their "new" mark). */
export function markKnown(config: TermiusConfig, keys: readonly string[]): TermiusConfig {
	const known = new Set(config.knownHosts ?? []);
	const before = known.size;
	for (const key of keys) known.add(key);
	return known.size === before && config.knownHosts ? config : { ...config, knownHosts: [...known].sort() };
}
