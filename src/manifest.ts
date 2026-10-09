/**
 * Single source of truth for the preset's desired state.
 *
 * Everything the /pi-preset sync flow writes is derived from this file. Nothing here may
 * carry a credential, a private host, or a personal preference: the repository
 * is public, and preferences (theme, defaultProvider, defaultModel,
 * defaultThinkingLevel) are deliberately out of scope.
 */

import type { JsonObject } from "./json-merge.ts";
import { getMcpConfigPath, getSettingsPath } from "./paths.ts";

/**
 * Extensions that must be present in settings.json `packages[]`.
 *
 * Empty: every extension the preset relies on is vendored under vendor/ and
 * loaded from this package itself (package.json `pi.extensions`), so
 * `pi update` on the preset updates all of them at once. vendor/UPSTREAM.json
 * records where each one came from; scripts/upstream.mjs follows upstream.
 *
 * Kept as a list so a future third-party package can be required again
 * without touching the sync code.
 */
export const REQUIRED_PACKAGES: readonly string[] = [];

/**
 * The preset's own packages[] source.
 *
 * packages[] is managed as a whitelist: after the checklist, every entry that
 * is neither required, a checked optional package, nor explicitly kept by the
 * user is planned for removal. The preset itself must never be on that list,
 * or a sync would uninstall the extension running it. A local-path install
 * (`pi install ~/pi-preset`) is recognised separately by resolving the path to
 * this package's root.
 */
export const PRESET_SELF_SOURCE = "git:github.com/zidou-kiyn/pi-preset";

/**
 * Extensions offered as opt-in checkboxes before a sync.
 *
 * Empty since the browser extension (@narumitw/pi-chrome-devtools) was
 * replaced by the official chrome-devtools MCP server (see JSON_PATCHES),
 * whose tools are reached through codemode instead of being declared. The
 * checklist still lists packages outside the preset.
 */
export interface OptionalPackage {
	/** settings.json packages[] source string. */
	source: string;
	/** Short display name for the checklist row. */
	label: string;
	/** One-line explanation rendered under the highlighted row. */
	description: string;
}

export const OPTIONAL_PACKAGES: readonly OptionalPackage[] = [];

/**
 * packages[] entries the preset replaced. A sync always removes them, with or
 * without the checklist, because keeping one is not a preference: most of
 * them register the same tool names as their vendored copy, and pi refuses to
 * start on a duplicate tool name. scripts/migrate-vendored.ts removes them
 * before the first start with the vendored preset.
 */
export interface SupersededPackage {
	source: string;
	reason: string;
}

const BUNDLED = (dir: string) => `bundled in pi-preset (vendor/${dir})`;

export const SUPERSEDED_PACKAGES: readonly SupersededPackage[] = [
	{ source: "npm:pi-patty-bg-tasks", reason: BUNDLED("pi-patty-bg-tasks") },
	{ source: "npm:pi-workspace-history", reason: BUNDLED("pi-workspace-history") },
	{ source: "npm:pi-wtf", reason: BUNDLED("pi-workspace-history/wtf") },
	{ source: "npm:@lll9p/pi-better-compaction", reason: BUNDLED("pi-better-compaction") },
	{ source: "git:github.com/zidou-kiyn/pi-better-compaction", reason: BUNDLED("pi-better-compaction") },
	{ source: "npm:@ff-labs/pi-fff", reason: BUNDLED("pi-fff") },
	{ source: "npm:@juicesharp/rpiv-todo", reason: BUNDLED("rpiv-todo") },
	{ source: "npm:@juicesharp/rpiv-ask-user-question", reason: BUNDLED("rpiv-ask-user-question") },
	{ source: "npm:pi-web-search", reason: BUNDLED("pi-web-search") },
	{ source: "git:github.com/code-yeongyu/pi-apply-patch", reason: BUNDLED("pi-apply-patch") },
	{ source: "npm:pi-context-view", reason: BUNDLED("pi-context-view") },
	{ source: "npm:pi-tool-display", reason: "replaced by the preset's compact-tools extension (both own `edit`)" },
	{ source: "npm:@narumitw/pi-chrome-devtools", reason: "replaced by the chrome-devtools MCP server in mcp.json" },
	{ source: "npm:@narumitw/pi-btw", reason: "dropped from the preset" },
	{ source: "npm:pi-btw", reason: "dropped from the preset" },
];

/**
 * JSON config files whose individual leaf keys the preset owns.
 *
 * Every entry is deep merged, never written whole: these files hold
 * hand-tuned preferences the preset has no business replacing. Both consumers
 * read keys optionally and fall back per key, so a partial file is valid and
 * a stale snapshot can never freeze an upstream default.
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

/** Pinned like any vendored code; bump it deliberately after checking the changelog. */
export const CHROME_DEVTOOLS_MCP_VERSION = "1.10.1";

export const JSON_PATCHES: readonly JsonPatchTarget[] = [
	{
		// pi's fullscreen TUI (docs/settings.md). Only these three leaves are
		// merged; packages[] in the same file is handled by its own step, and
		// applyJsonPatch re-reads the file so that step's write survives.
		// fullscreenCopyOnSelect: false keeps the clipboard untouched while
		// selecting; ctrl+x (app.message.copy) copies the selection instead.
		// enableInstallTelemetry: false stops pi's anonymous install/update
		// reports and provider attribution headers; update checks still run.
		id: "settings.json",
		resolvePath: getSettingsPath,
		patch: {
			tuiMode: "fullscreen",
			fullscreenWheelScrollLines: "auto",
			fullscreenCopyOnSelect: false,
			enableInstallTelemetry: false,
		},
		why: "fullscreen TUI with adaptive wheel scrolling; selection is copied with ctrl+x instead of on select; no install telemetry",
	},
	{
		// Google's chrome-devtools-mcp through pi's built-in MCP support, with
		// `codemode` exposure: none of its tools is declared to the model; a
		// codemode script calls them (tools.mcp__chrome_devtools__*), so one
		// script can navigate, wait, snapshot, and filter before anything
		// reaches the context, and the tool declarations never change mid-session.
		// It starts its own Chrome (a separate profile) on the first browser
		// call. Telemetry, CrUX lookups, and the npm update check are off.
		// `enabled` is not owned here, so turning the server off in /mcp
		// survives later syncs.
		id: "mcp.json",
		resolvePath: getMcpConfigPath,
		patch: {
			mcpServers: {
				"chrome-devtools": {
					command: "npx",
					args: [
						"-y",
						`chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
						"--no-usage-statistics",
						"--no-performance-crux",
					],
					env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
					exposure: "codemode",
					description: "Drive a Chrome browser: navigate, click, fill forms, evaluate JS, screenshots, console, network, performance traces",
				},
			},
		},
		why: "browser automation through the official chrome-devtools MCP server, called from codemode scripts",
	},
];

/** Extension directory name the packaged footer would collide with if it stayed local. */
export const LOCAL_FOOTER_DIR_NAME = "vibrant-footer";

/** Skills the package ships that older presets installed from upstream into the user's skill roots. */
export const BUNDLED_SKILLS: readonly string[] = ["grill-me", "grilling"];
