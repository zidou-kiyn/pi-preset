/**
 * Preset sync flow — reconcile this machine with the preset.
 *
 * Explicitly user-triggered and diff-first: it computes a read-only plan,
 * shows every change, and writes nothing until the confirmation is accepted.
 * confirm() returns false on "No", on Escape, and on timeout, so the single
 * `if (!confirmed) return;` below covers every decline path.
 *
 * In TUI mode the flow starts with the package checklist: optional
 * extensions (checked = keep/install) and every packages[] entry outside the
 * preset (unchecked by default = remove). packages[] is a whitelist, so
 * removals only ever come from this checklist. RPC and print modes never see
 * it and therefore never remove anything.
 *
 * Invoked from the /pi-preset main menu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { apply, renderApplyResult } from "./apply.ts";
import { OPTIONAL_PACKAGES } from "./manifest.ts";
import { selectPackagesWithUi } from "./optional-packages-ui.ts";
import { messages } from "./pi-preset-messages.ts";
import { type InstalledPackages, type PlanOptions, plan, readInstalledPackages, renderPlan } from "./plan.ts";
import type { FlowOutcome } from "./preset-menu.ts";

/**
 * Emit a multi-line report.
 *
 * notify() is a no-op without UI (the runner swaps in a no-op UI context in
 * print and json modes), so those modes fall back to stdout — the same thing
 * pi's own extension runner does for diagnostics.
 */
function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.log(message);
	}
}

/** Resolves "nothing-written" when the sync was cancelled or had nothing to apply. */
export async function runPresetSync(ctx: ExtensionCommandContext): Promise<FlowOutcome> {
	const m = messages();
	// The checklist is a full-screen custom component, so it only exists in TUI
	// mode. RPC and non-interactive modes sync the required set only and, with
	// no keep list, remove nothing.
	let planOptions: PlanOptions = {};
	if (ctx.mode === "tui") {
		let installed: InstalledPackages;
		try {
			installed = readInstalledPackages();
		} catch {
			// Unreadable settings surface as a plan blocker below.
			installed = { optional: new Set(), unlisted: [] };
		}
		if (OPTIONAL_PACKAGES.length > 0 || installed.unlisted.length > 0) {
			const picked = await selectPackagesWithUi(ctx, OPTIONAL_PACKAGES, installed.optional, installed.unlisted);
			if (picked === undefined) {
				ctx.ui.notify(m.syncCancelled, "info");
				return "nothing-written";
			}
			planOptions = { extraPackages: picked.extraPackages, keep: picked.keep };
		}
	}

	let syncPlan: Awaited<ReturnType<typeof plan>>;
	try {
		syncPlan = await plan(planOptions);
	} catch (error) {
		report(ctx, m.syncPlanFailed((error as Error).message), "error");
		return "nothing-written";
	}

	const body = renderPlan(syncPlan);

	// Nothing to do: skip the confirmation entirely so a repeat run is a
	// true no-op with no prompt and no writes. The body still prints, because
	// notes and blockers carry things the user must act on themselves.
	if (syncPlan.steps.length === 0) {
		if (syncPlan.blockers.length > 0) {
			report(ctx, `${m.syncNothingApplied}\n${body}`, "warning");
			return "nothing-written";
		}
		// Shown as a success: the machine matches the preset.
		report(ctx, `${m.syncAlreadyInSync}\n${body}`, "info");
		return "done";
	}

	// Without a dialog-capable UI there is no way to obtain consent, so
	// report the plan and stop rather than assuming approval.
	if (!ctx.hasUI) {
		console.log(
			[
				m.syncDryRun(ctx.mode),
				body,
				"",
				m.syncDryRunHint,
			].join("\n"),
		);
		return "nothing-written";
	}

	const confirmed = await ctx.ui.confirm(m.syncConfirmTitle, `${body}\n\n${m.syncConfirmQuestion}`);
	if (!confirmed) {
		ctx.ui.notify(m.syncCancelled, "info");
		return "nothing-written";
	}

	const result = await apply(syncPlan);
	const lines = [renderApplyResult(result)];

	if (result.ok) {
		if (
			result.results.some(
				(entry) => entry.kind === "settings.packages.add" || entry.kind === "settings.packages.remove",
			)
		) {
			// Extensions cannot reach pi's settings manager, so this session is
			// still holding the packages[] it loaded at startup. Anything that
			// makes pi persist settings before a restart writes that stale array
			// back over what was just changed.
			lines.push(m.restartPackages);
		}
		if (result.results.some((entry) => entry.kind === "footer.demote")) {
			lines.push(m.restartFooter);
		}
		if (result.results.some((entry) => entry.targetId === "pi-tool-display/config.json")) {
			// pi-tool-display reloads its config live but keeps whatever tool
			// overrides it already registered; its own modal says the same thing.
			lines.push(m.restartToolDisplay);
		}
		if (result.results.some((entry) => entry.targetId === "keybindings.json")) {
			lines.push(m.restartKeybindings);
		}
	}

	report(ctx, lines.join("\n"), result.ok ? "info" : "error");
	return "done";
}
