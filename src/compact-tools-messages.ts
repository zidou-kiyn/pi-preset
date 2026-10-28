/**
 * compact-tools UI text (en / zh): the hint under a collapsed edit row.
 * See src/i18n.ts for how a catalog works.
 */

import { localized } from "./i18n.ts";

const en = {
	moreLines: (hidden: number) => `… ${hidden} more line${hidden === 1 ? "" : "s"} (`,
	toExpand: "to expand",
	close: ")",
};

type Messages = typeof en;

const zh: Messages = {
	moreLines: (hidden) => `… 还有 ${hidden} 行（`,
	toExpand: "展开",
	close: "）",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
