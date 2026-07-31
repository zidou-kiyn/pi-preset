/**
 * Single source of truth for the preset's desired state.
 *
 * Everything /preset-sync writes is derived from this file. Nothing here may
 * carry a credential, a private host, or a personal preference: the repository
 * is public, and preferences (theme, defaultProvider, defaultModel,
 * defaultThinkingLevel) are deliberately out of scope.
 */

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
];

/**
 * The only web-search.json keys that genuinely deviate from upstream defaults.
 *
 * Both consumers read these optionally and fall back per key, so a partial file
 * is valid and a stale snapshot can never freeze an upstream default. This file
 * is also where every provider API key lives, which is why it is only ever deep
 * merged, never overwritten.
 */
export const WEB_SEARCH_PATCH = {
	webSearch: { enabled: false },
	ssrf: { trustEnvProxy: true },
} as const;

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
