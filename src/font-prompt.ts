/**
 * "Install the font" menu entry: the preset does not install fonts itself
 * (the method differs per OS and distribution); it sends this prompt to the
 * agent as a user message instead, so the current model does the work with
 * its normal tools and permission prompts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const FONT_FAMILY = "Maple Mono NF CN";

export const FONT_INSTALL_PROMPT = [
	`Install the ${FONT_FAMILY} font for my operating system.`,
	"First check whether it is already installed; if it is, stop and tell me.",
	"Otherwise download MapleMono-NF-CN-unhinted.zip from the latest release of github.com/subframe7536/maple-font,",
	"install it for my user only (no sudo/administrator rights), refresh the font cache if my OS has one,",
	"and tell me how to set it as my terminal's font.",
].join(" ");

/** Send the prompt; requires a model, queues as a follow-up while the agent is busy. */
export function sendFontInstallPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	if (!ctx.model) {
		ctx.ui.notify(
			"pi-preset font: no model is selected yet. Set one up first (Apply models.json template, then /model), then pick this entry again.",
			"warning",
		);
		return;
	}
	if (ctx.isIdle()) {
		pi.sendUserMessage(FONT_INSTALL_PROMPT);
	} else {
		pi.sendUserMessage(FONT_INSTALL_PROMPT, { deliverAs: "followUp" });
		ctx.ui.notify("pi-preset font: queued; it is sent when the current run finishes", "info");
	}
}
