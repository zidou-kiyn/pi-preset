/**
 * Decision logic for extensions/bash-bg-cap.ts, kept pure for tests.
 *
 * Under pi-patty-bg-tasks, the `bash` tool's `timeout` is the point where a
 * foreground command moves to the background, not a kill deadline. Models
 * read it as a kill deadline and pass several hundred seconds to protect long
 * builds, which keeps a hung command in the foreground for minutes. Capping it
 * only moves the command to the background sooner; it keeps running and
 * reports when it ends.
 */

export const DEFAULT_SECONDS = 30;
export const CAP_SECONDS = 60;

export interface BashBgCapConfig {
	/** Used when the model passes no timeout. */
	defaultSeconds: number;
	/** Upper bound for a timeout the model did pass. */
	capSeconds: number;
}

function parseSeconds(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Read PI_PRESET_BASH_BG_DEFAULT / PI_PRESET_BASH_BG_CAP. Either set to `off`
 * disables the extension (undefined). Invalid values fall back to the
 * defaults; a default above the cap is lowered to the cap.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): BashBgCapConfig | undefined {
	const rawDefault = env.PI_PRESET_BASH_BG_DEFAULT;
	const rawCap = env.PI_PRESET_BASH_BG_CAP;
	if (rawDefault?.trim().toLowerCase() === "off" || rawCap?.trim().toLowerCase() === "off") return undefined;
	const capSeconds = parseSeconds(rawCap, CAP_SECONDS);
	const defaultSeconds = Math.min(parseSeconds(rawDefault, DEFAULT_SECONDS), capSeconds);
	return { defaultSeconds, capSeconds };
}

/** Mirrors pi-patty-bg-tasks isAutoBackgroundAllowed: it KILLS these at the timeout. */
function isKilledAtTimeout(command: string): boolean {
	return (command.trim().split(/\s+/)[0] ?? "") === "sleep";
}

export interface BashInput {
	command?: unknown;
	timeout?: unknown;
	run_in_background?: unknown;
}

/**
 * The timeout to write into the call, or undefined to leave it untouched.
 * Never raises a timeout, never touches background runs, never touches a
 * command patty would kill instead of backgrounding.
 */
export function cappedTimeout(input: BashInput, config: BashBgCapConfig): number | undefined {
	if (input.run_in_background === true) return undefined;
	if (typeof input.command !== "string" || isKilledAtTimeout(input.command)) return undefined;
	const current = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
	const next = current === undefined ? config.defaultSeconds : Math.min(current, config.capSeconds);
	return next === current ? undefined : next;
}
