/**
 * escape-over-ssh — Esc that is quick, and a double Esc that counts as two,
 * over SSH.
 *
 * 1. Esc timeout inside tmux. A lone ESC byte may start a longer key
 *    sequence, so pi waits before taking it as the Esc key: 10 ms locally,
 *    100 ms when SSH_CONNECTION or SSH_TTY is set (the network can split a
 *    sequence). Inside tmux that wait is wasted: tmux has already assembled
 *    the keys on this machine and writes each one whole to the pane. So in
 *    tmux, unless PI_TUI_ESC_TIMEOUT is already set, it is set to 10 here.
 *    This runs when the extension loads, before pi starts reading the
 *    terminal, which is when pi reads the variable. Esc in every dialog goes
 *    from ~105 ms to ~14 ms.
 *
 * 2. Double Esc merged into Alt+Esc. Two quick presses can reach tmux in the
 *    same read (seen with Termius desktop). tmux, like any terminal parser,
 *    takes ESC ESC as Meta+Escape and hands pi one Alt+Esc: `\x1b[27;3u`
 *    with `extended-keys-format csi-u`, `\x1b[27;3;27~` with the xterm
 *    format, a bare `\x1b\x1b` without extended keys. pi binds nothing to
 *    Alt+Esc (matchesKey never matches `alt+escape`), so the press did
 *    nothing: no interrupt, and double Esc never opened /tree. A terminal
 *    input listener rewrites Alt+Esc to Esc and feeds a second Esc through
 *    stdin right after, so pi sees the two presses that were typed. Nothing
 *    is lost: pi has no use for Alt+Esc.
 *
 * Runtime: pi-preset/extensions/escape-over-ssh.ts
 * Command: none
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi-tui's lone-ESC wait outside SSH, used inside tmux too. */
export const TMUX_ESC_TIMEOUT_MS = "10";

/** Alt+Esc as tmux and xterm-style terminals send it. */
export const ALT_ESCAPE_SEQUENCES: ReadonlySet<string> = new Set(["\x1b[27;3u", "\x1b[27;3;27~", "\x1b\x1b"]);

/** Set PI_TUI_ESC_TIMEOUT for tmux unless the user chose a value. */
export function applyEscTimeout(env: NodeJS.ProcessEnv = process.env): void {
	if (env.TMUX && !env.PI_TUI_ESC_TIMEOUT) env.PI_TUI_ESC_TIMEOUT = TMUX_ESC_TIMEOUT_MS;
}

export default function escapeOverSsh(pi: ExtensionAPI): void {
	applyEscTimeout();

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
