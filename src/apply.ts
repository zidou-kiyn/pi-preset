/**
 * Execute a plan. This is the ONLY module in the package that writes.
 *
 * Steps run in order and stop at the first failure, but every step that already
 * completed stays applied and is reported truthfully — a half-applied sync is
 * reported as such rather than rolled back, because the writes are independent
 * and each is individually idempotent on the next run.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { deepMerge, type JsonObject, type JsonValue, readJsonObject, writeJsonObjectAtomic } from "./json-merge.ts";
import { packageEntrySource, packageIdentity, type Step, type SyncPlan } from "./plan.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { applyPrivatePermissions, formatMode } from "./permissions.ts";

export interface StepResult {
	kind: Step["kind"];
	/** Manifest id for json.patch steps, so callers can tell the patched files apart. */
	targetId?: string;
	ok: boolean;
	message: string;
}

export interface ApplyResult {
	results: StepResult[];
	/** True when every attempted step succeeded. */
	ok: boolean;
	/** Steps that never ran because an earlier one failed. */
	skipped: number;
}

function applyPackages(step: Extract<Step, { kind: "settings.packages.add" }>): string {
	// Re-read immediately before writing: the plan may be seconds old, and pi's
	// own package manager writes this same file.
	const settings = readJsonObject(step.settingsPath).data;

	const raw = settings.packages;
	if (raw !== undefined && !Array.isArray(raw)) {
		throw new Error(`"packages" in ${step.settingsPath} is not an array`);
	}

	const existing: JsonValue[] = Array.isArray(raw) ? [...raw] : [];
	// Re-derive identities from the file as it is NOW: pi may have installed one of
	// these itself since the plan was computed, possibly with a version suffix that
	// a string comparison would miss.
	const baseDir = dirname(step.settingsPath);
	const installed = new Set<string>();
	for (const entry of existing) {
		const source = packageEntrySource(entry);
		if (source) installed.add(packageIdentity(source, baseDir));
	}

	// Append only: never reorder, never drop entries the user added themselves.
	const appended = step.missing.filter((source) => !installed.has(packageIdentity(source, baseDir)));
	if (appended.length === 0) {
		// pi installed them between plan and apply. Writing anyway would rewrite a
		// credential-bearing file, bump its mtime, and clobber a good .preset-bak
		// with an identical one, all to change nothing.
		return "settings.json: already up to date, nothing written";
	}
	existing.push(...appended);

	// Top-level key with array semantics: a plain override, not a deep merge.
	writeJsonObjectAtomic(step.settingsPath, { ...settings, packages: existing });
	return `settings.json: added ${appended.length} package(s)`;
}

/** Deletes a removed package's installed files. Injectable so tests never spawn pi. */
export type PackageUninstaller = (source: string, agentDir: string) => Promise<void>;

/**
 * The pi CLI to spawn: the running one when pi is the host process, else `pi`
 * on PATH. Spawning the exact binary that is running avoids a PATH that points
 * at a different pi install.
 */
function piCommand(): { command: string; args: string[] } {
	let script = process.argv[1] ?? "";
	try {
		// argv[1] is usually the bin/pi symlink, not the package path.
		script = realpathSync(script);
	} catch {
		// Not a file (e.g. `node -e`): fall through to PATH.
	}
	if (/pi-coding-agent[\\/]/.test(script)) return { command: process.execPath, args: [script] };
	return { command: "pi", args: [] };
}

/**
 * `pi remove <source>`, with output captured.
 *
 * Goes through pi's own CLI so the npm root, the configured npmCommand, and git
 * checkout paths all match what the user would get by hand. Output is captured
 * rather than inherited: inherited npm output would print over the TUI.
 */
const piRemove: PackageUninstaller = (source, agentDir) =>
	new Promise((resolvePromise, reject) => {
		const { command, args } = piCommand();
		execFile(
			command,
			[...args, "remove", source],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				timeout: 180_000,
				shell: process.platform === "win32" && command === "pi",
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (!error) return resolvePromise();
				const detail = sanitizeTerminalText(`${stderr}${stdout}`.trim(), 500).replace(/\n+/g, " ");
				reject(new Error(detail || error.message));
			},
		);
	});

export interface ApplyOptions {
	/** Replaces `pi remove` for packages being removed. Tests only. */
	uninstall?: PackageUninstaller;
}

/** packages[] entries whose identity the step targets, split from the rest. */
function targetedEntries(
	settingsPath: string,
	identities: Set<string>,
): { settings: JsonObject; kept: JsonValue[]; removed: { source: string; identity: string }[] } {
	const settings = readJsonObject(settingsPath).data;
	const raw = settings.packages;
	if (raw !== undefined && !Array.isArray(raw)) {
		throw new Error(`"packages" in ${settingsPath} is not an array`);
	}
	const baseDir = dirname(settingsPath);
	const removed: { source: string; identity: string }[] = [];
	const kept = (Array.isArray(raw) ? raw : []).filter((entry) => {
		const source = packageEntrySource(entry);
		if (!source) return true;
		const identity = packageIdentity(source, baseDir);
		if (!identities.has(identity)) return true;
		removed.push({ source, identity });
		return false;
	});
	return { settings, kept, removed };
}

async function applyPackagesRemove(
	step: Extract<Step, { kind: "settings.packages.remove" }>,
	uninstall: PackageUninstaller,
): Promise<string> {
	const identities = new Set(step.remove.map((removal) => removal.identity));
	const agentDir = dirname(step.settingsPath);

	// Re-read immediately before acting, exactly like the add step.
	const before = targetedEntries(step.settingsPath, identities);
	if (before.removed.length === 0) {
		return "settings.json: packages to remove already gone, nothing written";
	}

	// `pi remove` first, while the entry still exists: it deletes the installed
	// files and drops the entry. Run after the entry is gone, it still deletes
	// the files but exits 1 ("No matching package"). One call per identity: a
	// second spelling of the same package would hit exactly that error. A
	// failure only costs disk space, so it is reported rather than thrown;
	// settings are fixed below either way.
	const failures: string[] = [];
	const uninstalled = new Set<string>();
	for (const { source, identity } of before.removed) {
		if (uninstalled.has(identity)) continue;
		uninstalled.add(identity);
		try {
			await uninstall(source, agentDir);
		} catch (error) {
			failures.push(`${source}: ${(error as Error).message}`);
		}
	}

	// Whatever pi remove left behind (it failed, or another spelling of the
	// same package is present) is dropped here, matched by identity.
	const after = targetedEntries(step.settingsPath, identities);
	if (after.removed.length > 0) {
		writeJsonObjectAtomic(step.settingsPath, { ...after.settings, packages: after.kept });
	}

	const sources = before.removed.map((entry) => entry.source);
	const message = `settings.json: removed ${uninstalled.size} package(s): ${sources.join(", ")}`;
	if (failures.length === 0) return `${message}; installed files deleted`;
	return `${message}; installed files may remain (run \`pi remove <source>\` to clean up): ${failures.join("; ")}`;
}

function applyJsonPatch(step: Extract<Step, { kind: "json.patch" }>): string {
	// Read again so keys written between plan and apply survive; a parse failure
	// here aborts the step rather than starting from {} and erasing API keys.
	const config = readJsonObject(step.configPath).data;
	const merged = deepMerge(config, step.patch);

	writeJsonObjectAtomic(step.configPath, merged);
	return `${step.targetId}: set ${step.changes.map((change) => change.key).join(", ")}`;
}

function applyFooterDemote(step: Extract<Step, { kind: "footer.demote" }>): string {
	if (!existsSync(step.from)) {
		return "footer: local copy already gone";
	}
	mkdirSync(dirname(step.to), { recursive: true });
	// Move, never delete: this may be the only copy of a hand-written footer.
	renameSync(step.from, step.to);
	return `footer: moved local copy to ${step.to}`;
}

async function runStep(step: Step, options: ApplyOptions): Promise<string> {
	switch (step.kind) {
		case "settings.packages.remove":
			return applyPackagesRemove(step, options.uninstall ?? piRemove);
		case "settings.packages.add":
			return applyPackages(step);
		case "json.patch":
			return applyJsonPatch(step);
		case "footer.demote":
			return applyFooterDemote(step);
		case "permissions.private": {
			const done = applyPrivatePermissions(step.changes);
			return done.length === 0
				? "permissions: already private"
				: `permissions: ${done.map((change) => `${change.path} ${formatMode(change.from)}->${formatMode(change.to)}`).join(", ")}`;
		}
	}
}

export async function apply(syncPlan: SyncPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
	const results: StepResult[] = [];

	for (let i = 0; i < syncPlan.steps.length; i++) {
		const step = syncPlan.steps[i]!;
		const identity = { kind: step.kind, ...(step.kind === "json.patch" ? { targetId: step.targetId } : {}) };
		try {
			results.push({ ...identity, ok: true, message: await runStep(step, options) });
		} catch (error) {
			results.push({ ...identity, ok: false, message: (error as Error).message });
			return { results, ok: false, skipped: syncPlan.steps.length - i - 1 };
		}
	}

	return { results, ok: true, skipped: 0 };
}

/** Render an apply result for the transcript. */
export function renderApplyResult(result: ApplyResult): string {
	const lines = result.results.map((entry) => `${entry.ok ? "ok  " : "FAIL"} ${entry.kind}: ${entry.message}`);
	if (result.skipped > 0) {
		lines.push(`--   ${result.skipped} later step(s) skipped after the failure above`);
	}
	return lines.join("\n");
}
