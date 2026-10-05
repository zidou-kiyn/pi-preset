/**
 * Decision logic for extensions/idle-keepwarm.ts, kept pure for tests.
 *
 * pi's own cache warmer refreshes during runs, but stops idle warming 30
 * minutes after the last real request, and a 1h cache is first refreshed at
 * 54 minutes — so with PI_CACHE_RETENTION=long nothing keeps the cache alive
 * past an hour of idling. The extension replays the last real Anthropic
 * request with max_tokens=1 shortly before the entry expires.
 */

export type Retention = "short" | "long";

/** Fallback lifetimes (seconds) when the model declares no promptCache. */
const FALLBACK_TTL_SECONDS: Record<Retention, number> = { short: 300, long: 3600 };

/** Refresh at 90% of the TTL, and never later than this before expiry. */
const MIN_MARGIN_MS = 15_000;

/** A refresh fired this close to (or after) expiry is skipped: it would be a full cache write. */
export const LATE_MARGIN_MS = 5_000;

export const KEEPWARM_ENV = "PI_PRESET_KEEPWARM";
export const MAX_IDLE_ENV = "PI_PRESET_KEEPWARM_MAX_IDLE";
/** Testing only: refresh this many seconds after each cache touch instead of at 90% of the TTL. */
export const EVERY_ENV = "PI_PRESET_KEEPWARM_EVERY_SEC";

export interface KeepwarmConfig {
	enabled: boolean;
	/** Stop refreshing after this long without a real request. Infinity = no limit. */
	maxIdleMs: number;
	/** Testing override for the refresh delay; undefined = 90% of the TTL. */
	everyMs?: number;
}

/** Parse "90m", "3h", "45" (minutes). Undefined for empty, "off", or invalid input. */
export function parseDuration(value: string | undefined): number | undefined {
	const text = value?.trim().toLowerCase();
	if (!text || text === "off" || text === "0") return undefined;
	const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr)?$/.exec(text);
	if (!match) return undefined;
	const minutes = Number(match[1]) * (match[2]?.startsWith("h") ? 60 : 1);
	return minutes > 0 ? minutes * 60_000 : undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): KeepwarmConfig {
	const enabled = env[KEEPWARM_ENV]?.trim().toLowerCase() !== "off";
	const every = Number(env[EVERY_ENV]);
	return {
		enabled,
		maxIdleMs: parseDuration(env[MAX_IDLE_ENV]) ?? Number.POSITIVE_INFINITY,
		...(every > 0 ? { everyMs: every * 1000 } : {}),
	};
}

/** pi's own warm replays and ours cap output at 1 token; real requests never do. */
export function isWarmReplay(payload: Record<string, unknown>): boolean {
	const cap = payload.max_tokens;
	return typeof cap === "number" && cap <= 16;
}

/** Whether the payload asks for prompt caching at all, and with which TTL. */
export function detectRetention(payload: Record<string, unknown>): Retention | undefined {
	let found: Retention | undefined;
	const visit = (value: unknown): void => {
		if (found === "long" || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		const control = record.cache_control;
		if (typeof control === "object" && control !== null) {
			found = (control as Record<string, unknown>).ttl === "1h" ? "long" : (found ?? "short");
		}
		for (const [key, child] of Object.entries(record)) {
			if (key !== "cache_control") visit(child);
		}
	};
	visit(payload.system);
	visit(payload.tools);
	visit(payload.messages);
	return found;
}

export function ttlMsFor(promptCache: Partial<Record<Retention, number>> | undefined, retention: Retention): number {
	return (promptCache?.[retention] ?? FALLBACK_TTL_SECONDS[retention]) * 1000;
}

export function refreshDelayMs(ttlMs: number, everyMs?: number): number {
	if (everyMs !== undefined) return Math.min(everyMs, ttlMs - MIN_MARGIN_MS);
	return Math.max(1_000, Math.floor(Math.min(ttlMs * 0.9, ttlMs - MIN_MARGIN_MS)));
}

/** The captured request with a one-token output cap; the cached prefix is untouched. */
export function warmPayload(payload: Record<string, unknown>): Record<string, unknown> {
	return { ...payload, max_tokens: 1, stream: true };
}

/**
 * Snapshot the extension publishes on globalThis for the footer. Extensions
 * share one process but not module instances, so a registry symbol is the
 * hand-off (the same pattern inherit-model.ts uses).
 */
export interface KeepwarmSnapshot {
	/** When the tracked cache entry expires, if one is tracked. */
	expiresAt?: number;
	/** When the next idle refresh fires, if one is scheduled. */
	nextWarmAt?: number;
	/** Successful refreshes since the last real request. */
	warms: number;
	/** A refresh request is in flight. */
	warming?: boolean;
	/** Why warming is paused, when it is. */
	note?: string;
}

export const KEEPWARM_SNAPSHOT_KEY = Symbol.for("pi-preset.idle-keepwarm.snapshot");

export function publishSnapshot(snapshot: KeepwarmSnapshot | undefined): void {
	(globalThis as Record<symbol, unknown>)[KEEPWARM_SNAPSHOT_KEY] = snapshot;
}

export function readSnapshot(): KeepwarmSnapshot | undefined {
	return (globalThis as Record<symbol, unknown>)[KEEPWARM_SNAPSHOT_KEY] as KeepwarmSnapshot | undefined;
}

/** Coarse countdown for a footer that repaints every ~30s: "58m", "1h05m", "<1m". */
export function formatRemaining(ms: number): string {
	if (ms < 60_000) return "<1m";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const rest = minutes % 60;
	return `${Math.floor(minutes / 60)}h${rest ? String(rest).padStart(2, "0") + "m" : ""}`;
}

export function formatClock(ts: number): string {
	const date = new Date(ts);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface WarmUsage {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/**
 * A refresh that read less than half of its prompt from cache rewrote it
 * instead: on a Claude subscription that cache write is the billed part, so
 * the caller stops rather than paying for it again.
 */
export function isCacheMiss(usage: WarmUsage | undefined): boolean {
	const read = usage?.cacheRead ?? 0;
	const prompt = (usage?.input ?? 0) + read + (usage?.cacheWrite ?? 0);
	return prompt > 0 && read < prompt / 2;
}
