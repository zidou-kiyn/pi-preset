/**
 * "Install the font" menu entry: the preset does not install fonts itself
 * (the method differs per OS and distribution); it sends this prompt to the
 * agent as a user message instead, so the current model does the whole job —
 * install plus the terminal's font setting — with its normal tools.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { messages } from "./pi-preset-messages.ts";

export const FONT_FAMILY = "Maple Mono Normal NF CN";

/**
 * Pinned: v8 is a pre-release, which GitHub's "latest release" skips. The
 * Normal build's family name differs from the plain "Maple Mono NF CN"; all
 * glyphs the footer uses were checked present in it.
 */
export const FONT_URL = "https://github.com/subframe7536/maple-font/releases/download/v8.0-beta.3/MapleMonoNormal-NF-CN-unhinted.zip";

/** Sent to the model, so it stays English whatever the UI language. */
export const FONT_INSTALL_PROMPT = [
	`Set up the ${FONT_FAMILY} font for me end to end; do every step yourself, do not hand any step back to me.`,
	"1. Check whether it is already installed for my operating system; if it is, skip to step 3.",
	`2. Download ${FONT_URL} (about 180 MB), install its .ttf files for my user only (no sudo/administrator rights), and refresh the font cache if my OS has one.`,
	`3. Find out which terminal emulator this pi session runs in (environment variables such as TERM_PROGRAM, the parent process chain, or the terminal's config files), and set its font to "${FONT_FAMILY}" in that terminal's own configuration, backing up any config file before you change it.`,
	"4. Verify the font is installed and the terminal config now names it, then report what you changed and whether the terminal must be restarted or a new window opened for the font to show.",
].join("\n");

/** Send the prompt; requires a model, queues as a follow-up while the agent is busy. */
export function sendFontInstallPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	if (!ctx.model) {
		ctx.ui.notify(messages().fontNoModel, "warning");
		return;
	}
	if (ctx.isIdle()) {
		pi.sendUserMessage(FONT_INSTALL_PROMPT);
	} else {
		pi.sendUserMessage(FONT_INSTALL_PROMPT, { deliverAs: "followUp" });
		ctx.ui.notify(messages().fontQueued, "info");
	}
}
