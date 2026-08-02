/**
 * Execute a plan. This is the ONLY module in the package that writes.
 *
 * Steps run in order and stop at the first failure, but every step that already
 * completed stays applied and is reported truthfully — a half-applied sync is
 * reported as such rather than rolled back, because the writes are independent
 * and each is individually idempotent on the next run.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { installFont } from "./font.ts";
import { deepMerge, type JsonValue, readJsonObject, writeJsonObjectAtomic } from "./json-merge.ts";
import { packageEntrySource, packageIdentity, type Step, type SyncPlan } from "./plan.ts";

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

async function applyFont(): Promise<string> {
	const result = await installFont();
	return result.message;
}

async function runStep(step: Step): Promise<string> {
	switch (step.kind) {
		case "settings.packages.add":
			return applyPackages(step);
		case "json.patch":
			return applyJsonPatch(step);
		case "footer.demote":
			return applyFooterDemote(step);
		case "font.install":
			return applyFont();
	}
}

export async function apply(syncPlan: SyncPlan): Promise<ApplyResult> {
	const results: StepResult[] = [];

	for (let i = 0; i < syncPlan.steps.length; i++) {
		const step = syncPlan.steps[i]!;
		const identity = { kind: step.kind, ...(step.kind === "json.patch" ? { targetId: step.targetId } : {}) };
		try {
			results.push({ ...identity, ok: true, message: await runStep(step) });
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
