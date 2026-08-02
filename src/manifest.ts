/**
 * Single source of truth for the preset's desired state.
 *
 * Everything /preset-sync writes is derived from this file. Nothing here may
 * carry a credential, a private host, or a personal preference: the repository
 * is public, and preferences (theme, defaultProvider, defaultModel,
 * defaultThinkingLevel) are deliberately out of scope.
 */

import type { JsonObject } from "./json-merge.ts";
import { getKeybindingsPath, getToolDisplayConfigPath, getWebSearchConfigPath } from "./paths.ts";

/**
 * Extensions that must be present in settings.json `packages[]`.
 *
 * These stay independent entries rather than bundled dependencies so that
 * `pi update --extensions` keeps applying to every one of them: package
 * updates only iterate sources explicitly listed in settings.
 *
 * Deliberately absent: `npm:pi-startup-redraw-fix`. It rewrites
 * `\x1b[3J\x1b[2J\x1b[H` into `\x1b[H\x1b[2J\x1b[3J`, but pi's alternate-screen
 * renderer emits `\x1b[2J\x1b[H\x1b[3J`, which never matches its trigger
 * sequence. The patch cannot fire, so it is not shipped.
 *
 * `pi-patty-bg-tasks` overrides the `bash` tool, which pi-tool-display also
 * claims. Two extensions registering one tool name is not a soft conflict: pi
 * reports it as a load ERROR (coding-agent core/resource-loader.ts
 * detectExtensionConflicts) and exits 1 (main.ts), so pi refuses to start at
 * all while both own `bash`. Reordering this list cannot help. The
 * pi-tool-display entry in JSON_PATCHES below is what makes the pair loadable.
 */
export const REQUIRED_PACKAGES: readonly string[] = [
	"npm:pi-wtf",
	"npm:pi-workspace-history",
	"npm:@ff-labs/pi-fff",
	"npm:pi-tool-display",
	"npm:@narumitw/pi-chrome-devtools",
	"npm:pi-playwright",
	"npm:pi-web-access",
	"npm:@lll9p/pi-better-compaction",
	"npm:pi-web-search",
	"git:github.com/code-yeongyu/pi-apply-patch",
	"npm:@juicesharp/rpiv-todo",
	"npm:@juicesharp/rpiv-ask-user-question",
	"npm:@amaster.ai/pi-image-gen",
	"npm:pi-patty-bg-tasks",
];

/**
 * JSON config files whose individual leaf keys the preset owns.
 *
 * Every entry is deep merged, never written whole: these files hold provider
 * API keys and hand-tuned preferences the preset has no business replacing.
 * Consumers of all three read keys optionally and fall back per key, so a
 * partial file is valid and a stale snapshot can never freeze an upstream
 * default.
 *
 * `resolvePath` is a function, not a string, because the path depends on
 * PI_CODING_AGENT_DIR at call time — a sandbox run must not inherit a value
 * captured when this module was first imported.
 */
export interface JsonPatchTarget {
	/** Short id used in plan lines, notes, and blockers. */
	id: string;
	resolvePath: () => string;
	/** Leaf keys to enforce. Everything else in the file is preserved. */
	patch: JsonObject;
	/** One-line reason, rendered under the diff so the write is never unexplained. */
	why?: string;
}

export const JSON_PATCHES: readonly JsonPatchTarget[] = [
	{
		id: "web-search.json",
		resolvePath: getWebSearchConfigPath,
		patch: {
			webSearch: { enabled: false },
			ssrf: { trustEnvProxy: true },
		},
	},
	{
		// Without this, pi-tool-display and pi-patty-bg-tasks both register `bash`
		// and pi aborts startup with `Tool "bash" conflicts with ...` (verified in
		// a sandbox on pi 0.83.0). This is pi-tool-display's own documented opt-out;
		// every other tool it renders is left untouched.
		id: "pi-tool-display/config.json",
		resolvePath: getToolDisplayConfigPath,
		patch: { registerToolOverrides: { bash: false } },
		why: "pi refuses to start while both extensions own the bash tool; pi-tool-display keeps read/grep/find/ls/edit/write",
	},
	{
		// pi's default `tui.editor.cursorLeft` is ["left", "ctrl+b"], and
		// pi-patty-bg-tasks registers ctrl+b unconditionally. The extension wins
		// the key either way, but pi prints an "Extension shortcut conflict"
		// warning on every startup until the built-in claim is dropped. A user key
		// list REPLACES the default list, so ["left"] is what removes ctrl+b.
		id: "keybindings.json",
		resolvePath: getKeybindingsPath,
		patch: { "tui.editor.cursorLeft": ["left"] },
		why: "drops the emacs-style ctrl+b cursor-left binding so pi stops warning about the pi-patty-bg-tasks shortcut",
	},
];

/**
 * Nerd Font used by the footer's nf-md-* glyphs.
 *
 * No version is pinned anywhere: detection keys on the family name, which is
 * stable across releases, and installation resolves whatever asset the latest
 * GitHub release currently offers. Filenames are NOT stable across releases
 * (older builds used underscores instead of hyphens), so an installed font is
 * never matched by filename when the family name is available.
 */
export const FONT = {
	family: "Maple Mono NF CN",
	repo: "subframe7536/maple-font",
	assetPattern: /^MapleMono-NF-CN-unhinted\.zip$/,
	releasesPage: "https://github.com/subframe7536/maple-font/releases/latest",
	/** Filename fragments used when fc-list is unavailable and only a directory scan is possible. */
	fileHints: ["maple", "nf", "cn"],
	/** Subdirectory created under the Linux user font directory. */
	linuxDirName: "maple-nf-cn",
} as const;

/** Extension directory name the packaged footer would collide with if it stayed local. */
export const LOCAL_FOOTER_DIR_NAME = "vibrant-footer";

/** Printed after a sync; pi-image-gen needs provider credentials that this package must never ship. */
export const POST_SYNC_REMINDER =
	"pi-image-gen needs its own provider credentials. Configure them locally; the preset never ships keys.";
