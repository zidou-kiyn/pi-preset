/**
 * Skills-sync flow — install or refresh Matt Pocock's two-part grilling workflow.
 * Invoked from the /pi-preset main menu.
 *
 * The upstream files are deliberately not vendored in this package. Every run
 * uses the filtered official skills CLI, with an outer snapshot/rollback layer
 * so a partial installer failure cannot destroy the previous working pair.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type ApplySkillSyncOptions,
	applySkillSync,
	renderSkillSyncApplyResult,
	type SkillSyncApplyResult,
} from "./skills-sync-apply.ts";
import { sanitizeTerminalText } from "./skills-sync-output.ts";
import { createSkillSyncPlan, renderSkillSyncPlan, type SkillSyncPlan } from "./skills-sync-plan.ts";

export interface PresetSkillsSyncDependencies {
	createPlan?: () => SkillSyncPlan;
	apply?: (plan: SkillSyncPlan, options?: ApplySkillSyncOptions) => Promise<SkillSyncApplyResult>;
}

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// JSON mode must keep stdout valid JSONL. Print mode has no protocol, so a
	// normal diagnostic is useful there.
	if (ctx.mode === "json") console.error(message);
	else console.log(message);
}

export async function runPresetSkillsSync(
	ctx: ExtensionCommandContext,
	dependencies: PresetSkillsSyncDependencies = {},
): Promise<void> {
	let syncPlan: SkillSyncPlan;
	try {
		syncPlan = dependencies.createPlan?.() ?? createSkillSyncPlan();
	} catch (error) {
		report(
			ctx,
			`pi-preset skills: could not compute a plan: ${sanitizeTerminalText((error as Error).message, 2_000)}`,
			"error",
		);
		return;
	}
	const body = renderSkillSyncPlan(syncPlan);

	if (syncPlan.blockers.length > 0) {
		report(ctx, `pi-preset skills: cannot continue\n${body}`, "warning");
		return;
	}

	if (!ctx.hasUI) {
		report(
			ctx,
			[
				`pi-preset skills plan (${ctx.mode} mode, dry run — no consent possible here):`,
				body,
				"",
				"Run /pi-preset in TUI or RPC mode to apply.",
			].join("\n"),
			"info",
		);
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Sync upstream skills?",
		`${body}\n\nThis uses network access and writes the two global skill entries. Continue?`,
	);
	if (!confirmed) {
		ctx.ui.notify("pi-preset skills: cancelled, nothing was written", "info");
		return;
	}

	const apply = dependencies.apply ?? applySkillSync;
	let result: SkillSyncApplyResult;
	try {
		result = await apply(syncPlan, { cwd: ctx.cwd });
	} catch (error) {
		report(
			ctx,
			`pi-preset skills: apply failed before a result was produced: ${sanitizeTerminalText((error as Error).message, 2_000)}`,
			"error",
		);
		return;
	}
	report(ctx, renderSkillSyncApplyResult(result), result.ok ? "info" : "error");

	if (!result.ok || !result.changed) return;

	// Notify before reload; reload is terminal for this command handler because
	// the old extension context is stale once the resource set is replaced.
	ctx.ui.notify(
		"pi-preset skills: skill content changed; reloading Pi resources now (restart Pi if reload fails)",
		"info",
	);
	await ctx.reload();
	return;
}
