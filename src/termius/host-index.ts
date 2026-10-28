/**
 * The host list as pi sees it, from `login-json` action `hosts`: every host
 * (disabled ones too), with its cloud id, tags, route, and the cloud ids of
 * the jump hosts its route goes through. No secrets.
 *
 * The approval gate resolves the `name` an agent passed (id or label) to a
 * cloud id here, so a session allow or a host level applies however the
 * host is named. The /termius host list renders from it.
 */

import { isRouteMode, type RouteMode } from "./config.ts";

export interface RouteInfo {
	mode: RouteMode;
	source: "host" | "global";
	jump_hosts: string[];
	proxy: string | null;
	/** Set when the route cannot be used (a proxy it needs is missing, a jump host is gone). */
	error?: string;
}

export interface HostRow {
	id: number;
	cloud_id: string;
	label: string;
	address: string;
	port: number;
	group: string | null;
	username: string | null;
	tags: string[];
	os: string | null;
	route: RouteInfo;
	/** Cloud ids of the jump hosts this host's route goes through. */
	via: string[];
}

export interface HostList {
	loggedIn: boolean;
	rows: HostRow[];
	lastSynced?: string;
	syncError?: string;
}

/** Runs `login-json` with `{ action: "hosts", sync }`. */
export type FetchHosts = (sync: boolean) => Promise<Record<string, unknown>>;

function text(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function parseRoute(value: unknown): RouteInfo {
	const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const route: RouteInfo = {
		mode: isRouteMode(source.mode) ? source.mode : "termius",
		source: source.source === "host" ? "host" : "global",
		jump_hosts: Array.isArray(source.jump_hosts) ? source.jump_hosts.map(String) : [],
		proxy: text(source.proxy),
	};
	if (typeof source.error === "string" && source.error) route.error = source.error;
	return route;
}

export function parseHostRow(value: unknown): HostRow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.cloud_id !== "string") return undefined;
	return {
		id: Number(row.id),
		cloud_id: row.cloud_id,
		label: text(row.label) ?? text(row.address) ?? row.cloud_id,
		address: text(row.address) ?? "",
		port: Number(row.port) || 22,
		group: text(row.group),
		username: text(row.username),
		tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
		os: text(row.os),
		route: parseRoute(row.route),
		via: Array.isArray(row.via) ? row.via.map(String) : [],
	};
}

export class HostIndex {
	private list: HostList | undefined;
	private pending: Promise<HostList | undefined> | undefined;
	private failure: string | undefined;
	private readonly fetchHosts: FetchHosts;

	constructor(fetchHosts: FetchHosts) {
		this.fetchHosts = fetchHosts;
	}

	/** The last list loaded, if any. */
	get current(): HostList | undefined {
		return this.list;
	}

	/** Why the last refresh failed, if it did. */
	get error(): string | undefined {
		return this.failure;
	}

	get loading(): boolean {
		return this.pending !== undefined;
	}

	/** Load the list (pulling first when `sync` and the cache is old). Concurrent calls share one load. */
	refresh(sync = false): Promise<HostList | undefined> {
		this.pending ??= (async () => {
			try {
				const response = await this.fetchHosts(sync);
				if (response.ok !== true) {
					this.failure = String(response.error ?? response.code ?? "unknown error");
					return this.list;
				}
				const rows = (Array.isArray(response.hosts) ? response.hosts : []).map(parseHostRow).filter((row): row is HostRow => row !== undefined);
				rows.sort((a, b) => a.label.localeCompare(b.label));
				this.list = {
					loggedIn: response.logged_in === true,
					rows,
					lastSynced: text(response.last_synced) ?? undefined,
					syncError: text(response.sync_error) ?? undefined,
				};
				this.failure = undefined;
				return this.list;
			} catch (error) {
				this.failure = (error as Error).message;
				return this.list;
			} finally {
				this.pending = undefined;
			}
		})();
		return this.pending;
	}

	/** Forget the list (sign-out). */
	clear(): void {
		this.list = undefined;
	}

	/** Hosts `name` can mean: the numeric id, the cloud id, or the exact label (labels can repeat). */
	resolve(name: string): HostRow[] {
		const rows = this.list?.rows ?? [];
		const trimmed = name.trim();
		const byId = /^\d+$/.test(trimmed) ? rows.filter((row) => row.id === Number(trimmed)) : [];
		const byLabel = rows.filter((row) => row.label === trimmed);
		return [...new Set([...byId, ...byLabel])];
	}

	find(cloudId: string): HostRow | undefined {
		return this.list?.rows.find((row) => row.cloud_id === cloudId);
	}

	/** How many hosts reach their target through this one. */
	jumpHostFor(cloudId: string): number {
		return this.list?.rows.filter((row) => row.via.includes(cloudId)).length ?? 0;
	}
}
