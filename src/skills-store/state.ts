/**
 * Which store skills are enabled, at three levels:
 *
 *   always   every session, everywhere      <agent dir>/pi-preset/skills-state.json
 *   project  every session in this cwd      same file, keyed by directory
 *   session  until this pi process exits    <agent dir>/pi-preset/skills-session-<pid>.json
 *
 * The session level lives in a file rather than in memory because `/reload`
 * replaces the extension runtime and re-runs `resources_discover`, and the
 * reported skills must survive that. The file is keyed by pid, removed on
 * shutdown, and files of dead processes are swept at startup.
 *
 * A fresh state file enables `DEFAULT_ALWAYS` (the small skill-authoring and
 * git-conventions guides); turning one off is remembered like any other choice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../paths.ts";

export type Level = "always" | "project" | "session";
export const LEVELS: readonly Level[] = ["session", "project", "always"];

export const DEFAULT_ALWAYS: readonly string[] = ["skill-authoring", "git-conventions"];

export interface PersistentState {
	always: string[];
	projects: Record<string, string[]>;
	/** The one-time offer to move pi's own skill directories into the store was made. */
	importOffered?: boolean;
}

export function stateDir(): string {
	return join(getAgentDir(), "pi-preset");
}

export function statePath(): string {
	return join(stateDir(), "skills-state.json");
}

export function sessionPath(pid: number = process.pid): string {
	return join(stateDir(), `skills-session-${pid}.json`);
}

function uniqueNames(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

export function readState(path: string = statePath()): PersistentState {
	if (!existsSync(path)) return { always: [...DEFAULT_ALWAYS], projects: {} };
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistentState>;
		const projects: Record<string, string[]> = {};
		for (const [cwd, names] of Object.entries(data.projects ?? {})) {
			const list = uniqueNames(names);
			if (list.length > 0) projects[cwd] = list;
		}
		return { always: uniqueNames(data.always), projects, importOffered: data.importOffered === true };
	} catch {
		return { always: [], projects: {} };
	}
}

export function writeState(state: PersistentState, path: string = statePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const data: PersistentState = { always: state.always, projects: state.projects };
	if (state.importOffered) data.importOffered = true;
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readSession(path: string = sessionPath()): string[] {
	try {
		return uniqueNames(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return [];
	}
}

export function writeSession(names: readonly string[], path: string = sessionPath()): void {
	if (names.length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(names)}\n`);
}

/** Remove session files left by processes that no longer exist. */
export function sweepSessions(dir: string = stateDir(), alive: (pid: number) => boolean = processAlive): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const match = entry.match(/^skills-session-(\d+)\.json$/u);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || alive(pid)) continue;
		rmSync(join(dir, entry), { force: true });
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The level a skill is enabled at in `cwd`, the strongest first; undefined when off. */
export function levelOf(name: string, cwd: string, state: PersistentState, session: readonly string[]): Level | undefined {
	if (state.always.includes(name)) return "always";
	if (state.projects[cwd]?.includes(name)) return "project";
	if (session.includes(name)) return "session";
	return undefined;
}

/** Names enabled in `cwd` at any level, with the level each one is enabled at. */
export function enabledIn(cwd: string, state: PersistentState, session: readonly string[]): Map<string, Level> {
	const result = new Map<string, Level>();
	for (const name of session) result.set(name, "session");
	for (const name of state.projects[cwd] ?? []) result.set(name, "project");
	for (const name of state.always) result.set(name, "always");
	return result;
}

export interface Enabler {
	state: PersistentState;
	session: string[];
}

/**
 * Set a skill's level in `cwd` (undefined = off everywhere). A skill holds
 * one level at a time: enabling at one level clears the others, so the menu
 * shows a single state and "off" means off.
 */
export function setLevel(target: Enabler, name: string, cwd: string, level: Level | undefined): void {
	target.state.always = target.state.always.filter((item) => item !== name);
	const project = (target.state.projects[cwd] ?? []).filter((item) => item !== name);
	if (project.length > 0) target.state.projects[cwd] = project;
	else delete target.state.projects[cwd];
	target.session = target.session.filter((item) => item !== name);
	if (level === "always") target.state.always.push(name);
	else if (level === "project") target.state.projects[cwd] = [...project, name];
	else if (level === "session") target.session.push(name);
}
