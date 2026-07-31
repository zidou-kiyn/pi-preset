/**
 * /preset-sync — reconcile this machine with the preset.
 *
 * Explicitly user-triggered and diff-first: it computes a read-only plan,
 * shows every change, and writes nothing until the confirmation is accepted.
 * confirm() returns false on "No", on Escape, and on timeout, so the single
 * `if (!confirmed) return;` below covers every decline path.
 *
 * Runtime: pi-preset/extensions/preset-sync.ts
 * Command: /preset-sync
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { apply, renderApplyResult } from "../src/apply.ts";
import { POST_SYNC_REMINDER } from "../src/manifest.ts";
import { plan, renderPlan } from "../src/plan.ts";

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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("preset-sync", {
		description: "Apply the personal pi preset (packages, web-search keys, footer, font)",
		handler: async (_args, ctx) => {
			let syncPlan: Awaited<ReturnType<typeof plan>>;
			try {
				syncPlan = await plan();
			} catch (error) {
				report(ctx, `preset-sync: could not compute a plan: ${(error as Error).message}`, "error");
				return;
			}

			const body = renderPlan(syncPlan);

			// Nothing to do: skip the confirmation entirely so a repeat run is a
			// true no-op with no prompt and no writes. The body still prints, because
			// notes carry things the user must act on themselves — a manual font
			// install on Windows is reported here and nowhere else.
			if (syncPlan.steps.length === 0) {
				if (syncPlan.blockers.length > 0) {
					report(ctx, `preset-sync: nothing applied\n${body}`, "warning");
				} else {
					report(ctx, `preset-sync: already in sync\n${body}`, "info");
				}
				return;
			}

			// Without a dialog-capable UI there is no way to obtain consent, so
			// report the plan and stop rather than assuming approval.
			if (!ctx.hasUI) {
				console.log(
					[
						`preset-sync plan (${ctx.mode} mode, dry run — no consent possible here):`,
						body,
						"",
						"Run /preset-sync in interactive mode to apply.",
					].join("\n"),
				);
				return;
			}

			const confirmed = await ctx.ui.confirm("Apply preset?", `${body}\n\nApply these changes?`);
			if (!confirmed) {
				ctx.ui.notify("preset-sync: cancelled, nothing was written", "info");
				return;
			}

			const result = await apply(syncPlan);
			const lines = [renderApplyResult(result)];

			if (result.ok) {
				lines.push("", POST_SYNC_REMINDER);
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
			}

			report(ctx, lines.join("\n"), result.ok ? "info" : "error");
		},
	});
}
