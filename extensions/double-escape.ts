/**
 * double-escape — a double Esc that arrives as one Alt+Esc still counts as two.
 *
 * Why: over SSH (seen with Termius desktop into tmux) two quick Esc presses
 * reach tmux in the same read. tmux, like any terminal parser, takes ESC ESC
 * as Meta+Escape and passes one Alt+Esc to pi: `\x1b[27;3u` with
 * `extended-keys-format csi-u`, `\x1b[27;3;27~` with the xterm format, or a
 * bare `\x1b\x1b` without extended keys. pi binds no action to Alt+Esc
 * (matchesKey never matches `alt+escape`), so the press does nothing: no
 * interrupt, and double Esc never opens /tree (`doubleEscapeAction`).
 *
 * Fix: a terminal input listener rewrites Alt+Esc to Esc and feeds a second
 * Esc through stdin right after, so pi sees the two presses that were typed.
 * pi's own escape timeout (`PI_TUI_ESC_TIMEOUT`) still applies to the second
 * one, well inside its 500 ms double-press window. Nothing is lost: pi has no
 * use for Alt+Esc.
 *
 * Runtime: pi-preset/extensions/double-escape.ts
 * Command: none (terminal input listener only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Alt+Esc as tmux and xterm-style terminals send it. */
export const ALT_ESCAPE_SEQUENCES: ReadonlySet<string> = new Set(["\x1b[27;3u", "\x1b[27;3;27~", "\x1b\x1b"]);

export default function doubleEscape(pi: ExtensionAPI): void {
	// One listener at a time: each extra one would add another Esc.
	let unsubscribe: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") return;
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!ALT_ESCAPE_SEQUENCES.has(data)) return undefined;
			// After this event is dispatched, not inside it: the second Esc goes
			// through pi's stdin buffer like a real key press.
			setImmediate(() => process.stdin.emit("data", "\x1b"));
			return { data: "\x1b" };
		});
	});
}
