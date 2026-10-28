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
 *   4. Language          — auto / 中文 / English for the preset's own UI
 *                          (src/i18n.ts; PI_PRESET_LANG overrides it)
 *
 * Escape at the menu (or any later prompt) writes nothing. Non-interactive
 * modes (print, json) render the sync dry-run plan, matching the old
 * /preset-sync behavior. RPC mode gets a plain select menu; the models
 * template flow still requires full TUI and says so instead of writing.
 *
 * Runtime: pi-preset/extensions/pi-preset.ts
 * Command: /pi-preset, /pi-preset language <auto|en|zh>
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FONT_FAMILY, sendFontInstallPrompt } from "../src/font-prompt.ts";
import { type Lang, LANGUAGE_CHOICES, type LanguageChoice, langOf, localeLang, readLanguageChoice, writeLanguageChoice } from "../src/i18n.ts";
import { runPresetModelsTemplate } from "../src/models-template-run.ts";
import { messages } from "../src/pi-preset-messages.ts";
import { plan, type SyncPlan } from "../src/plan.ts";
import {
	captureNotices,
	chooseValue,
	type FlowOutcome,
	type MenuItem,
	type Notice,
	Signal,
	showMenu,
} from "../src/preset-menu.ts";
import { runPresetSync } from "../src/preset-sync-run.ts";
import { presetVersion } from "../src/version.ts";

/** Each language is named in its own language, whatever the UI language. */
const LANGUAGE_NAMES: Record<Lang, string> = { zh: "中文", en: "English" };

/** The saved language choice as the menu shows it: "Auto (English)", "中文", "English". */
export function languageHint(choice: LanguageChoice = readLanguageChoice()): string {
	return choice === "auto" ? messages().languageAutoHint(LANGUAGE_NAMES[localeLang()]) : LANGUAGE_NAMES[choice];
}

/** Set when PI_PRESET_LANG decides the language, so a saved choice has no effect yet. */
function languageOverride(): string | undefined {
	const value = process.env.PI_PRESET_LANG?.trim();
	return value && langOf(value) ? value : undefined;
}

/** Save a language choice; the notice is built after saving, so it is already in the new language. */
export function saveLanguage(choice: LanguageChoice): Notice {
	writeLanguageChoice(choice);
	const m = messages();
	const forced = languageOverride();
	const saved = m.languageSaved(languageHint(choice));
	return forced ? { text: `${saved}\n${m.languageForced(forced)}`, type: "warning" } : { text: saved, type: "success" };
}

/** The menu, built on every render so a language change shows at once. */
export function menuItems(): MenuItem[] {
	const m = messages();
	const forced = languageOverride();
	return [
		{ value: "sync", label: m.syncLabel, description: m.syncHelp },
		{ value: "models", label: m.modelsLabel, description: m.modelsHelp },
		{ value: "font", label: m.fontLabel(FONT_FAMILY), description: m.fontHelp },
		{
			value: "language",
			label: m.languageLabel,
			hint: languageHint(),
			description: forced ? `${m.languageHelp}\n${m.languageForced(forced)}` : m.languageHelp,
		},
	];
}

/** One status line for the sync plan: in sync, what would change, or why it cannot be planned. */
export function summarizePlan(syncPlan: SyncPlan): string {
	const m = messages();
	if (syncPlan.blockers.length > 0) return m.configBlocked(syncPlan.blockers[0]!);
	if (syncPlan.steps.length === 0) return m.configInSync;
	const parts = syncPlan.steps.map((step) => {
		switch (step.kind) {
			case "settings.packages.add":
				return m.packagesToAdd(step.missing.length);
			case "settings.packages.remove":
				return m.packagesToRemove(step.remove.length);
			case "json.patch":
				return m.keysToSet(step.targetId, step.changes.length);
			case "footer.demote":
				return m.footerToRetire;
			case "permissions.private":
				return m.filePermissions;
		}
	});
	return m.configToSync(parts.join(m.listSeparator));
}

/** The language picker: auto / 中文 / English, the saved choice ticked. Resolves with a notice, or undefined for Esc. */
async function chooseLanguage(ctx: ExtensionCommandContext): Promise<Notice | undefined> {
	const m = messages();
	const forced = languageOverride();
	const value = await chooseValue(
		ctx,
		m.languageTitle,
		[
			{ value: "auto", label: m.languageAuto, description: m.languageAutoHelp(LANGUAGE_NAMES[localeLang()]) },
			{ value: "zh", label: LANGUAGE_NAMES.zh },
			{ value: "en", label: LANGUAGE_NAMES.en },
		],
		readLanguageChoice(),
		forced ? [m.languageForced(forced)] : undefined,
	);
	return value === undefined ? undefined : saveLanguage(value as LanguageChoice);
}

export default function piPresetExtension(pi: ExtensionAPI): void {
	const runMenu = async (ctx: ExtensionCommandContext) => {
		let notice: Notice | undefined;
		let selected: string | undefined;
		// The plan, kept rather than its summary, so the status line follows a language change.
		let planned: SyncPlan | Error | undefined;
		const status = () =>
			planned === undefined
				? messages().configChecking
				: planned instanceof Error
					? messages().configBlocked(planned.message)
					: summarizePlan(planned);
		const changed = new Signal();
		const refresh = () => {
			// Local files only (~40 ms); packages outside the preset are decided in the checklist.
			plan()
				.then((result) => {
					planned = result;
				})
				.catch((error: Error) => {
					planned = error;
				})
				.finally(() => changed.emit());
		};
		// The flows report through notify(); show that in the menu instead. A plain
		// "info" result is a success unless the flow says nothing was written.
		const quiet = captureNotices(ctx, (next) => {
			notice = next;
		});
		const run = async (flow: () => Promise<FlowOutcome>) => {
			const outcome = await flow();
			if (notice?.type === "info" && outcome === "done") notice = { ...notice, type: "success" };
		};
		for (;;) {
			refresh();
			const choice = await showMenu(
				ctx,
				() => ({ title: `pi-preset ${presetVersion()}`, status: [status()], notice, items: menuItems(), selected }),
				changed.subscribe,
			);
			if (!choice) return;
			selected = choice;
			notice = undefined;
			try {
				if (choice === "sync") await run(() => runPresetSync(quiet));
				else if (choice === "models") await run(() => runPresetModelsTemplate(quiet));
				else if (choice === "language") notice = await chooseLanguage(ctx);
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
		description: "Preset control panel: sync packages/config, models.json template, font, language",
		getArgumentCompletions: (prefix) => {
			const [first, second] = prefix.trimStart().split(/\s+/);
			if (first === "language" && second !== undefined) {
				return LANGUAGE_CHOICES.filter((choice) => choice.startsWith(second)).map((choice) => ({
					value: `language ${choice}`,
					label: choice,
				}));
			}
			return "language".startsWith(first ?? "") ? [{ value: "language", label: "language" }] : null;
		},
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "language") {
				if (!(LANGUAGE_CHOICES as readonly string[]).includes(value ?? "")) {
					ctx.ui.notify(`${messages().languageUsage} · ${languageHint()}`, "warning");
					return;
				}
				const saved = saveLanguage(value as LanguageChoice);
				ctx.ui.notify(saved.text, saved.type === "success" ? "info" : "warning");
				return;
			}
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
