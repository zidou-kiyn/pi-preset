/**
 * What the user granted for this session only: hosts allowed from the
 * approval dialog, and temporary levels set in a host's detail page.
 *
 * Both last until /new, a switch to another session, or a restart of pi.
 * They survive /reload: every change is appended to the session as a custom
 * entry (never part of the model's context), and session_start with reason
 * "reload" reads the newest one back. A later /resume into the session does
 * not restore them; an old session should not come back with old grants.
 */

import { isLevel, type Level } from "./levels.ts";

export const SESSION_ENTRY = "termius-session";

export interface SessionSnapshot {
	allowed: string[];
	temporary: Record<string, Level>;
}

export class SessionGrants {
	private readonly allowed = new Set<string>();
	private readonly temporary = new Map<string, Level>();

	isAllowed(key: string): boolean {
		return this.allowed.has(key);
	}

	allow(key: string): void {
		this.allowed.add(key);
	}

	revoke(key: string): void {
		this.allowed.delete(key);
	}

	temporaryLevel(key: string): Level | undefined {
		return this.temporary.get(key);
	}

	/** `undefined` clears it. */
	setTemporary(key: string, level: Level | undefined): void {
		if (level === undefined) this.temporary.delete(key);
		else this.temporary.set(key, level);
	}

	/** Hosts with a session allow or a temporary level. */
	keys(): Set<string> {
		return new Set([...this.allowed, ...this.temporary.keys()]);
	}

	get count(): number {
		return this.keys().size;
	}

	clear(): void {
		this.allowed.clear();
		this.temporary.clear();
	}

	snapshot(): SessionSnapshot {
		return { allowed: [...this.allowed].sort(), temporary: Object.fromEntries([...this.temporary].sort(([a], [b]) => a.localeCompare(b))) };
	}

	restore(snapshot: SessionSnapshot | undefined): void {
		this.clear();
		if (!snapshot) return;
		for (const key of snapshot.allowed) this.allowed.add(key);
		for (const [key, level] of Object.entries(snapshot.temporary)) this.temporary.set(key, level);
	}
}

function parseSnapshot(data: unknown): SessionSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const source = data as Record<string, unknown>;
	const allowed = Array.isArray(source.allowed) ? source.allowed.filter((key): key is string => typeof key === "string") : [];
	const temporary: Record<string, Level> = {};
	if (source.temporary && typeof source.temporary === "object") {
		for (const [key, level] of Object.entries(source.temporary as Record<string, unknown>)) {
			if (isLevel(level)) temporary[key] = level;
		}
	}
	return { allowed, temporary };
}

/** The newest snapshot among session entries (oldest first, as getBranch returns them). */
export function lastSnapshot(entries: readonly unknown[]): SessionSnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type === "custom" && entry.customType === SESSION_ENTRY) return parseSnapshot(entry.data);
	}
	return undefined;
}
