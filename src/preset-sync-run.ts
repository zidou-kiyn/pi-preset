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
import { type InstalledPackages, type PlanOptions, plan, readInstalledPackages, renderPlan } from "./plan.ts";

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

export async function runPresetSync(ctx: ExtensionCommandContext): Promise<void> {
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
				ctx.ui.notify("pi-preset sync: cancelled, nothing was written", "info");
				return;
			}
			planOptions = { extraPackages: picked.extraPackages, keep: picked.keep };
		}
	}

	let syncPlan: Awaited<ReturnType<typeof plan>>;
	try {
		syncPlan = await plan(planOptions);
	} catch (error) {
		report(ctx, `pi-preset sync: could not compute a plan: ${(error as Error).message}`, "error");
		return;
	}

	const body = renderPlan(syncPlan);

	// Nothing to do: skip the confirmation entirely so a repeat run is a
	// true no-op with no prompt and no writes. The body still prints, because
	// notes and blockers carry things the user must act on themselves.
	if (syncPlan.steps.length === 0) {
		if (syncPlan.blockers.length > 0) {
			report(ctx, `pi-preset sync: nothing applied\n${body}`, "warning");
		} else {
			report(ctx, `pi-preset sync: already in sync\n${body}`, "info");
		}
		return;
	}

	// Without a dialog-capable UI there is no way to obtain consent, so
	// report the plan and stop rather than assuming approval.
	if (!ctx.hasUI) {
		console.log(
			[
				`pi-preset sync plan (${ctx.mode} mode, dry run — no consent possible here):`,
				body,
				"",
				"Run /pi-preset in interactive mode to apply.",
			].join("\n"),
		);
		return;
	}

	const confirmed = await ctx.ui.confirm("Apply preset?", `${body}\n\nApply these changes?`);
	if (!confirmed) {
		ctx.ui.notify("pi-preset sync: cancelled, nothing was written", "info");
		return;
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
			lines.push(
				"Restart pi to load the updated package set — before using /config or pi install in this session, which would persist this session's older packages[] over it.",
			);
		}
		if (result.results.some((entry) => entry.kind === "footer.demote")) {
			lines.push("Restart pi so the footer loads once, from the package.");
		}
		if (result.results.some((entry) => entry.targetId === "pi-tool-display/config.json")) {
			// pi-tool-display reloads its config live but keeps whatever tool
			// overrides it already registered; its own modal says the same thing.
			lines.push("Restart pi (or /reload) so pi-tool-display releases the bash tool.");
		}
		if (result.results.some((entry) => entry.targetId === "keybindings.json")) {
			lines.push("Restart pi so the ctrl+b keybinding change takes effect.");
		}
	}

	report(ctx, lines.join("\n"), result.ok ? "info" : "error");
}
