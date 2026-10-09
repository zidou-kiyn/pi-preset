/**
 * /pi-preset — the preset's single visual control panel.
 *
 * One TUI menu replaces the former /preset-sync, /preset-skills-sync, and
 * /preset-models-add commands:
 *
 *   1. Sync preset       — optional-extension checklist, then the diff-first sync
 *   2. Grilling skills   — install or refresh the upstream grill-me/grilling pair
 *   3. Models template   — replace models.json with the preset template and set
 *                          the default provider/model (TUI only)
 *   4. Install the font  — sends the font-install prompt to the current model
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
import type { TUI } from "@earendil-works/pi-tui";
import { FONT_FAMILY, sendFontInstallPrompt } from "../src/font-prompt.ts";
import { runPresetModelsTemplate } from "../src/models-template-run.ts";
import { type DescribedOption, DescribedSelectComponent } from "../src/preset-ui.ts";
import { runPresetSync } from "../src/preset-sync-run.ts";
import { runPresetSkillsSync } from "../src/skills-sync-run.ts";

const MENU_OPTIONS: readonly DescribedOption[] = [
	{
		id: "sync",
		label: "Sync preset",
		description:
			"Packages, config keys, and footer. Starts with the optional browser-extension checklist, shows a full diff, and writes only after confirmation.",
	},
	{
		id: "skills",
		label: "Install / refresh grilling skills",
		description:
			"Installs or refreshes the upstream grill-me and grilling pair via the official skills CLI. Uses network access; shows a plan and asks first.",
	},
	{
		id: "models",
		label: "Apply models.json template",
		description:
			"Replaces models.json with the preset's OpenAI/Anthropic/DeepSeek providers. Fill in each base URL and API key now or keep placeholders, then pick the default provider and model for settings.json. The old file is kept as models.json.preset-bak.",
	},
	{
		id: "font",
		label: `Install the ${FONT_FAMILY} font (ask pi)`,
		description:
			"Sends a prompt to the current model asking it to check for the footer's Nerd Font and, if missing, download and install it for your user with its normal tools, then explain how to set it as the terminal font. Needs a working model.",
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
		description: "Preset control panel: sync packages/config, grilling skills, models.json template, font",
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
					await runPresetModelsTemplate(ctx);
					return;
				case "font":
					sendFontInstallPrompt(pi, ctx);
					return;
				default:
					// Escape / cancelled menu: nothing was chosen, nothing is written.
					return;
			}
		},
	});
}
