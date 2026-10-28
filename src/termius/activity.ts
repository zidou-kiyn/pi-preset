/**
 * The log of remote calls behind /termius → Recent activity.
 *
 * One JSON line per exec / files call in <install dir>/activity.jsonl:
 * when, which host, how it was reached, the command or file action, who let
 * it run (or refused it), and the exit code. Never the output. The file is
 * 0600 in the server's directory, which the guard keeps agent tools out of;
 * the newest 500 entries are kept. Sign-out keeps it; the menu can clear it.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "./install.ts";
import type { ActivityDecision } from "./messages.ts";

export const ACTIVITY_LIMIT = 500;
/** Rewrite the file once it holds this many lines, back down to the limit. */
const TRIM_AT = 600;
const DETAIL_LIMIT = 500;

export interface ActivityEntry {
	/** ISO time. */
	time: string;
	/** Host label as shown when the call was made. */
	host: string;
	/** Cloud id, when the host was known. */
	key?: string;
	tool: "exec" | "files";
	/** The command, or `<action> <path>` for files. */
	detail: string;
	/** How the host was reached, e.g. "jump host bastion (1.2.3.4)", "direct". */
	route?: string;
	decision: ActivityDecision;
	/** Exit code of exec; null when it timed out. */
	exit?: number | null;
	/** Error code when the call failed (host_disabled, ssh_failed, ...). */
	error?: string;
}

export function activityPath(): string {
	return join(installDir(), "activity.jsonl");
}

function parse(line: string): ActivityEntry | undefined {
	try {
		const entry = JSON.parse(line) as ActivityEntry;
		return typeof entry?.time === "string" && typeof entry.host === "string" ? entry : undefined;
	} catch {
		return undefined;
	}
}

/** Entries, newest first. */
export function readActivity(): ActivityEntry[] {
	let text: string;
	try {
		text = readFileSync(activityPath(), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map(parse)
		.filter((entry): entry is ActivityEntry => entry !== undefined)
		.reverse();
}

export function appendActivity(entry: ActivityEntry): void {
	const path = activityPath();
	const line = `${JSON.stringify({ ...entry, detail: entry.detail.length > DETAIL_LIMIT ? `${entry.detail.slice(0, DETAIL_LIMIT)}…` : entry.detail })}\n`;
	mkdirSync(installDir(), { recursive: true });
	appendFileSync(path, line, { mode: 0o600 });
	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	} catch {
		return;
	}
	if (lines.length < TRIM_AT) return;
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${lines.slice(-ACTIVITY_LIMIT).join("\n")}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

export function clearActivity(): void {
	rmSync(activityPath(), { force: true });
}

/** Calls since local midnight, and how many of them were denied or refused. */
export function activityToday(entries: readonly ActivityEntry[], now = new Date()): { total: number; denied: number } {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const today = entries.filter((entry) => Date.parse(entry.time) >= midnight);
	return { total: today.length, denied: today.filter((entry) => entry.decision === "denied" || entry.decision === "refused" || entry.decision === "no-ui").length };
}
