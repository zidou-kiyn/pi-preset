/**
 * vibrant-footer UI text (en / zh). See src/i18n.ts for how a catalog works.
 *
 * Only the words the bar shows by default are here. The word labels behind
 * PI_PRESET_FOOTER_LABELS=1 (in, out, cache r, w, hit, ttl, warm, pkg, mcp,
 * history) stay English: they are terse abbreviations next to numbers.
 */

import { localized } from "./i18n.ts";

const en = {
	snapshotFailed: "snapshot failed",
	expired: "expired",
	now: "now",
	working: "working",
	footerOn: "Ramp status bar on",
	footerOff: "Default footer restored",
};

type Messages = typeof en;

const zh: Messages = {
	snapshotFailed: "快照失败",
	expired: "已过期",
	now: "进行中",
	working: "进行中",
	footerOn: "Ramp 状态栏已开启",
	footerOff: "已恢复默认状态栏",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
