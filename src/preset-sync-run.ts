/**
 * Preset sync flow — reconcile this machine with the preset.
 *
 * Explicitly user-triggered and diff-first: it computes a read-only plan,
 * shows every change, and writes nothing until the confirmation is accepted.
 * confirm() returns false on "No", on Escape, and on timeout, so the single
 * `if (!confirmed) return;` below covers every decline path.
 *
 * In TUI mode the flow starts with the optional-extension checklist
 * (chrome-devtools, playwright): only checked entries join the desired
 * package set, and already-installed entries are locked because the preset
 * never removes packages.
 *
 * Invoked from the /pi-preset main menu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { apply, renderApplyResult } from "./apply.ts";
import { readJsonObject } from "./json-merge.ts";
import { OPTIONAL_PACKAGES } from "./manifest.ts";
import { selectOptionalPackagesWithUi } from "./optional-packages-ui.ts";
import { getSettingsPath } from "./paths.ts";
import { packageEntrySource, packageIdentity, plan, renderPlan } from "./plan.ts";

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

/** Optional-package sources already present in settings.json, by package identity. */
function installedOptionalSources(): Set<string> {
	const settingsPath = getSettingsPath();
	const baseDir = dirname(settingsPath);

	let packages: unknown;
	try {
		packages = readJsonObject(settingsPath).data.packages;
	} catch {
		// Unreadable settings will surface as a plan blocker; the checklist just
		// starts with nothing pre-checked.
		return new Set();
	}
	if (!Array.isArray(packages)) return new Set();

	const installed = new Set<string>();
	for (const entry of packages) {
		const source = packageEntrySource(entry);
		if (source) installed.add(packageIdentity(source, baseDir));
	}

	return new Set(
		OPTIONAL_PACKAGES.filter((pkg) => installed.has(packageIdentity(pkg.source, baseDir))).map((pkg) => pkg.source),
	);
}

export async function runPresetSync(ctx: ExtensionCommandContext): Promise<void> {
	// The checklist is a full-screen custom component, so it only exists in TUI
	// mode. RPC and non-interactive modes sync the required set only.
	let extraPackages: string[] = [];
	if (ctx.mode === "tui" && OPTIONAL_PACKAGES.length > 0) {
		const picked = await selectOptionalPackagesWithUi(ctx, OPTIONAL_PACKAGES, installedOptionalSources());
		if (picked === undefined) {
			ctx.ui.notify("pi-preset sync: cancelled, nothing was written", "info");
			return;
		}
		extraPackages = picked;
	}

	let syncPlan: Awaited<ReturnType<typeof plan>>;
	try {
		syncPlan = await plan({ extraPackages });
	} catch (error) {
		report(ctx, `pi-preset sync: could not compute a plan: ${(error as Error).message}`, "error");
		return;
	}

	const body = renderPlan(syncPlan);

	// Nothing to do: skip the confirmation entirely so a repeat run is a
	// true no-op with no prompt and no writes. The body still prints, because
	// notes carry things the user must act on themselves — a manual font
	// install on Windows is reported here and nowhere else.
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
		if (result.results.some((entry) => entry.kind === "settings.packages.add")) {
			// Extensions cannot reach pi's settings manager, so this session is
			// still holding the packages[] it loaded at startup. Anything that
			// makes pi persist settings before a restart writes that stale array
			// back over what was just added.
			lines.push(
				"Restart pi to install and load the newly added packages — before using /config or pi install in this session, which would persist this session's older packages[] over them.",
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
