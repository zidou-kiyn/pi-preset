import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FONT_INSTALL_PROMPT, sendFontInstallPrompt } from "../src/font-prompt.ts";

function setup(options: { model: boolean; idle: boolean }) {
	const sent: { content: unknown; options: unknown }[] = [];
	const notifications: string[] = [];
	const pi = {
		sendUserMessage: (content: unknown, sendOptions?: unknown) => sent.push({ content, options: sendOptions }),
	} as unknown as ExtensionAPI;
	const ctx = {
		model: options.model ? { id: "m", provider: "p" } : undefined,
		isIdle: () => options.idle,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	return { pi, ctx, sent, notifications };
}

test("an idle session sends the font prompt immediately", () => {
	const { pi, ctx, sent } = setup({ model: true, idle: true });
	sendFontInstallPrompt(pi, ctx);
	assert.deepEqual(sent, [{ content: FONT_INSTALL_PROMPT, options: undefined }]);
});

test("a busy session queues the prompt as a follow-up", () => {
	const { pi, ctx, sent, notifications } = setup({ model: true, idle: false });
	sendFontInstallPrompt(pi, ctx);
	assert.deepEqual(sent, [{ content: FONT_INSTALL_PROMPT, options: { deliverAs: "followUp" } }]);
	assert.match(notifications.join("\n"), /queued/);
});

test("without a model nothing is sent", () => {
	const { pi, ctx, sent, notifications } = setup({ model: false, idle: true });
	sendFontInstallPrompt(pi, ctx);
	assert.equal(sent.length, 0);
	assert.match(notifications.join("\n"), /no model is selected/);
});
