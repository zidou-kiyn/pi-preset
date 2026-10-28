/**
 * Access levels and what they decide for one remote call.
 *
 *   off        the host is disabled: hidden from the agent, every call refused
 *   read-only  reads run; writes are refused without asking
 *   review     every call asks
 *   auto       reads run; writes ask
 *   trusted    everything runs
 *
 * Catastrophic commands (approval.ts) ask at every level, session allows
 * included, and are refused on a read-only host. A host's level comes from,
 * first match: its temporary level for this session, its own setting, the
 * global level. "Allow this host for this session" skips the questions
 * that level would ask, but not the catastrophic ones and not a refusal.
 */

export const LEVELS = ["off", "read-only", "review", "auto", "trusted"] as const;
export type Level = (typeof LEVELS)[number];

export const GLOBAL_LEVELS = ["read-only", "review", "auto", "trusted"] as const;
export type GlobalLevel = (typeof GLOBAL_LEVELS)[number];

export const DEFAULT_GLOBAL_LEVEL: GlobalLevel = "auto";

export function isLevel(value: unknown): value is Level {
	return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** A global level; `dangerously` (the old name of trusted) is accepted. */
export function parseGlobalLevel(value: unknown): GlobalLevel | undefined {
	if (value === "dangerously") return "trusted";
	return typeof value === "string" && (GLOBAL_LEVELS as readonly string[]).includes(value) ? (value as GlobalLevel) : undefined;
}

/** A host level; `dangerously` is accepted as trusted. */
export function parseLevel(value: unknown): Level | undefined {
	if (value === "dangerously") return "trusted";
	return isLevel(value) ? value : undefined;
}

export type OperationKind = "read" | "write";

export type LevelSource = "temporary" | "host" | "global";

export interface EffectiveLevel {
	level: Level;
	source: LevelSource;
	/** "Allow this host for this session" was chosen. */
	sessionAllowed: boolean;
}

export interface LevelInputs {
	globalLevel: GlobalLevel;
	hostLevel?: Level;
	temporaryLevel?: Level;
	sessionAllowed?: boolean;
}

export function effectiveLevel(inputs: LevelInputs): EffectiveLevel {
	const sessionAllowed = inputs.sessionAllowed === true;
	if (inputs.temporaryLevel) return { level: inputs.temporaryLevel, source: "temporary", sessionAllowed };
	if (inputs.hostLevel) return { level: inputs.hostLevel, source: "host", sessionAllowed };
	return { level: inputs.globalLevel, source: "global", sessionAllowed };
}

export type Decision =
	| { action: "run" }
	| { action: "ask"; catastrophic: boolean }
	| { action: "refuse"; because: "off" | "read-only" };

/** What one call does at this level. */
export function decide(effective: EffectiveLevel, kind: OperationKind, catastrophic: boolean): Decision {
	const { level } = effective;
	if (level === "off") return { action: "refuse", because: "off" };
	if (level === "read-only" && (kind === "write" || catastrophic)) return { action: "refuse", because: "read-only" };
	if (catastrophic) return { action: "ask", catastrophic: true };
	if (effective.sessionAllowed || level === "trusted") return { action: "run" };
	if (level === "review") return { action: "ask", catastrophic: false };
	if (level === "auto" && kind === "write") return { action: "ask", catastrophic: false };
	return { action: "run" };
}

/** Order from most to least restrictive, for picking the strictest of several matches. */
const STRICTNESS: Record<Level, number> = { off: 0, "read-only": 1, review: 2, auto: 3, trusted: 4 };

export function stricter(a: EffectiveLevel, b: EffectiveLevel): EffectiveLevel {
	if (STRICTNESS[a.level] !== STRICTNESS[b.level]) return STRICTNESS[a.level] < STRICTNESS[b.level] ? a : b;
	return a.sessionAllowed ? b : a;
}
