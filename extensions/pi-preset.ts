/**
 * /pi-preset — the preset's single visual control panel.
 *
 * One TUI menu replaces the former /preset-sync, /preset-skills-sync, and
 * /preset-models-add commands:
 *
 *   1. Sync preset      — optional-extension checklist, then the diff-first sync
 *   2. Grilling skills  — install or refresh the upstream grill-me/grilling pair
 *   3. Add model provider — the masked models.json wizard (TUI only)
 *
 * Escape at the menu (or any later prompt) writes nothing. Non-interactive
 * modes (print, json) render the sync dry-run plan, matching the old
 * /preset-sync behavior. RPC mode gets a plain select menu; the model wizard
 * still requires full TUI and says so instead of writing anything.
 *
 * Runtime: pi-preset/extensions/pi-preset.ts
 * Command: /pi-preset
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { runPresetModelsAdd } from "../src/models-add-run.ts";
import { type DescribedOption, DescribedSelectComponent } from "../src/models-wizard-ui.ts";
import { runPresetSync } from "../src/preset-sync-run.ts";
import { runPresetSkillsSync } from "../src/skills-sync-run.ts";

const MENU_OPTIONS: readonly DescribedOption[] = [
	{
		id: "sync",
		label: "Sync preset",
		description:
			"Packages, config keys, footer, and font. Starts with the optional browser-extension checklist, shows a full diff, and writes only after confirmation.",
	},
	{
		id: "skills",
		label: "Install / refresh grilling skills",
		description:
			"Installs or refreshes the upstream grill-me and grilling pair via the official skills CLI. Uses network access; shows a plan and asks first.",
	},
	{
		id: "models",
		label: "Add model provider",
		description:
			"Masked wizard for Anthropic/OpenAI/DeepSeek bundles or a fully custom endpoint. Writes only the selected provider to models.json.",
	},
];

async function selectMenuAction(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (ctx.mode === "tui") {
		return ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
			return new DescribedSelectComponent(
				"pi-preset",
				MENU_OPTIONS,
				theme,
				keybindings,
				() => tui.requestRender(),
				done,
			);
		});
	}
	// RPC has dialogs but no custom components: fall back to a plain select.
	const label = await ctx.ui.select(
		"pi-preset",
		MENU_OPTIONS.map((option) => option.label),
	);
	return MENU_OPTIONS.find((option) => option.label === label)?.id;
}

export default function piPresetExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pi-preset", {
		description: "Preset control panel: sync packages/config/font, grilling skills, model providers",
		handler: async (_args, ctx) => {
			// print/json: no dialogs exist, so the only useful output is the sync
			// dry-run plan — runPresetSync renders exactly that and stops.
			if (!ctx.hasUI) {
				await runPresetSync(ctx);
				return;
			}

			const action = await selectMenuAction(ctx);
			switch (action) {
				case "sync":
					await runPresetSync(ctx);
					return;
				case "skills":
					await runPresetSkillsSync(ctx);
					return;
				case "models":
					await runPresetModelsAdd(ctx);
					return;
				default:
					// Escape / cancelled menu: nothing was chosen, nothing is written.
					return;
			}
		},
	});
}
