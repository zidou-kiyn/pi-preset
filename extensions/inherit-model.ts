/**
 * inherit-model — carry the active model and thinking level across `/new`.
 *
 * Why: `/new` rebuilds the session from settings (`defaultModel`,
 * `defaultThinkingLevel`) or CLI flags, so a model picked with `/model` or
 * ctrl+p is dropped every time a fresh session starts. `/resume` and `/fork`
 * already restore their own session's model and are left alone.
 *
 * Fix: on `session_shutdown` with reason "new" stash the current
 * provider/model/thinking level; on the paired `session_start` reapply it.
 * The value lives on `globalThis` because `/new` recreates the resource
 * loader and every extension instance, so module-level state would not
 * survive the switch. If the model is no longer available or its provider
 * has no auth, pi's default is kept and nothing else is touched.
 *
 * Runtime: pi-preset/extensions/inherit-model.ts
 * Command: none (event hooks only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface Saved {
	provider: string;
	id: string;
	thinking: ThinkingLevel;
}

const KEY = "__pi_preset_inherit_model__";
const store = globalThis as typeof globalThis & { [KEY]?: Saved };

export default function inheritModel(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "new" || !ctx.model) return;
		store[KEY] = {
			provider: ctx.model.provider,
			id: ctx.model.id,
			thinking: pi.getThinkingLevel(),
		};
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;
		const saved = store[KEY];
		if (!saved) return;
		delete store[KEY]; // consume once; never let a stale value leak into a later /new

		const model = ctx.modelRegistry.find(saved.provider, saved.id);
		if (!model) return;

		const alreadyActive = ctx.model?.provider === model.provider && ctx.model?.id === model.id;
		if (!alreadyActive && !(await pi.setModel(model))) return; // false = no auth for provider
		pi.setThinkingLevel(saved.thinking);
	});
}
