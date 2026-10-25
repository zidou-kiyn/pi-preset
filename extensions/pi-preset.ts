/**
 * /pi-preset — the preset's control panel, on the shared preset menu
 * (src/preset-menu.ts): the sync state at the top, and after an action the
 * menu comes back with its result instead of closing.
 *
 *   1. Sync preset       — package checklist, then the diff-first sync
 *   2. Models template   — replace models.json with the preset template and set
 *                          the default provider/model (TUI only)
 *   3. Install the font  — sends the font-install prompt to the current model
 *                          (closes the menu: the agent starts working)
 *
 * Escape at the menu (or any later prompt) writes nothing. Non-interactive
 * modes (print, json) render the sync dry-run plan, matching the old
 * /preset-sync behavior. RPC mode gets a plain select menu; the models
 * template flow still requires full TUI and says so instead of writing.
 *
 * Runtime: pi-preset/extensions/pi-preset.ts
 * Command: /pi-preset
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FONT_FAMILY, sendFontInstallPrompt } from "../src/font-prompt.ts";
import { runPresetModelsTemplate } from "../src/models-template-run.ts";
import { plan, type SyncPlan } from "../src/plan.ts";
import { captureNotices, type MenuItem, type Notice, Signal, showMenu } from "../src/preset-menu.ts";
import { runPresetSync } from "../src/preset-sync-run.ts";
import { presetVersion } from "../src/version.ts";

const MENU_ITEMS: readonly MenuItem[] = [
	{
		value: "sync",
		label: "Sync preset",
		description:
			"Packages, config keys (including the chrome-devtools MCP server), and footer. Starts with a checklist of packages outside the preset, shows a full diff, and writes only after confirmation.",
	},
	{
		value: "models",
		label: "Apply models.json template",
		description:
			"Replaces models.json with the preset's OpenAI/Anthropic/DeepSeek providers. Fill in each base URL and API key now or keep placeholders, then pick the default provider and model for settings.json. The old file is kept as models.json.preset-bak.",
	},
	{
		value: "font",
		label: `Install the ${FONT_FAMILY} font (ask pi)`,
		description:
			"Sends a prompt to the current model asking it to install the footer's Nerd Font for your user if it is missing and to set it as your terminal's font in the terminal's config (backing it up first). Needs a working model; closes this menu.",
	},
];

/** One status line for the sync plan: in sync, what would change, or why it cannot be planned. */
export function summarizePlan(syncPlan: SyncPlan): string {
	if (syncPlan.blockers.length > 0) return `Config: cannot plan a sync (${syncPlan.blockers[0]})`;
	if (syncPlan.steps.length === 0) return "Config: in sync with the preset";
	const parts = syncPlan.steps.map((step) => {
		switch (step.kind) {
			case "settings.packages.add":
				return `${step.missing.length} package(s) to add`;
			case "settings.packages.remove":
				return `${step.remove.length} package(s) to remove`;
			case "json.patch":
				return `${step.targetId} (${step.changes.length} key${step.changes.length === 1 ? "" : "s"})`;
			case "footer.demote":
				return "local footer to retire";
			case "permissions.private":
				return "file permissions";
		}
	});
	return `Config: ${parts.join(", ")} to sync`;
}

export default function piPresetExtension(pi: ExtensionAPI): void {
	const runMenu = async (ctx: ExtensionCommandContext) => {
		let notice: Notice | undefined;
		let selected: string | undefined;
		let status = "Config: checking…";
		const changed = new Signal();
		const refresh = () => {
			// Local files only (~40 ms); packages outside the preset are decided in the checklist.
			plan()
				.then((result) => {
					status = summarizePlan(result);
				})
				.catch((error: Error) => {
					status = `Config: cannot plan a sync (${error.message})`;
				})
				.finally(() => changed.emit());
		};
		// The flows report through notify(); show that in the menu instead. A plain
		// "info" result is a success unless it says nothing happened.
		const quiet = captureNotices(ctx, (next) => {
			const nothing = /cancelled|nothing was written/.test(next.text);
			notice = { text: next.text, type: next.type !== "info" ? next.type : nothing ? "info" : "success" };
		});
		for (;;) {
			refresh();
			const choice = await showMenu(
				ctx,
				() => ({ title: `pi-preset ${presetVersion()}`, status: [status], notice, items: MENU_ITEMS, selected }),
				changed.subscribe,
			);
			if (!choice) return;
			selected = choice;
			notice = undefined;
			try {
				if (choice === "sync") await runPresetSync(quiet);
				else if (choice === "models") await runPresetModelsTemplate(quiet);
				else if (choice === "font") {
					sendFontInstallPrompt(pi, ctx);
					return;
				}
			} catch (error) {
				notice = { text: (error as Error).message, type: "error" };
			}
		}
	};

	pi.registerCommand("pi-preset", {
		description: "Preset control panel: sync packages/config, models.json template, font",
		handler: async (_args, ctx) => {
			// print/json: no dialogs exist, so the only useful output is the sync
			// dry-run plan — runPresetSync renders exactly that and stops.
			if (!ctx.hasUI) {
				await runPresetSync(ctx);
				return;
			}
			await runMenu(ctx);
		},
	});
}
