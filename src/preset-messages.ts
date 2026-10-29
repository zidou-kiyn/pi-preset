/**
 * UI text shared by every preset command (en / zh): the menu's key hints,
 * the small components in preset-ui.ts, and the package checklist before a
 * sync. See src/i18n.ts for how a catalog works.
 */

import { localized } from "./i18n.ts";

const en = {
	// preset-menu.ts
	menuKeys: (cancel: string) => `↑↓ move · Enter or number select · Esc ${cancel}`,
	menuKeysFilter: (cancel: string) => `type to filter · ↑↓ move · Enter select · Esc clear / ${cancel}`,
	filterHint: "type to filter",
	noMatches: "no matches",
	moreAbove: (n: number) => `↑ ${n} more`,
	moreBelow: (n: number) => `↓ ${n} more`,
	close: "close",
	back: "back",

	// preset-ui.ts
	maskedHint: "The key is hidden while you type.",
	reviewChanges: "Review the changes below.",
	showingLines: (from: number, to: number, total: number) => `showing ${from}-${to} of ${total}`,
	reviewKeys: "↑↓/PageUp/PageDown scroll · Enter apply · Esc cancel",
	selectKeys: "↑↓ navigate · Enter select · Esc cancel",

	// optional-packages-ui.ts
	optionalTitle: "Optional extensions",
	optionalHelp: "Checked = installed after the sync. Unchecking an installed one removes it.",
	unlistedTitle: "Packages not in the preset",
	unlistedHelp: "Check the ones to keep. Unchecked packages are removed.",
	unlistedLocal:
		"Not part of the preset. Unchecked: the entry is removed from settings.json; the local directory itself is left alone.",
	unlistedInstalled: (kind: string) =>
		`Not part of the preset. Unchecked: \`pi remove\` drops it from settings.json and deletes its installed ${kind} files.`,
	installedWillBeRemoved: "installed, will be removed",
	installed: "installed",
	willBeRemoved: "will be removed",
	continue: "Continue",
	checklistKeys: "↑↓ navigate · Enter toggle/continue · Esc cancel",
};

type Messages = typeof en;

const zh: Messages = {
	menuKeys: (cancel) => `↑↓ 移动 · Enter 或数字选择 · Esc ${cancel}`,
	menuKeysFilter: (cancel) => `输入即过滤 · ↑↓ 移动 · Enter 选择 · Esc 清空 / ${cancel}`,
	filterHint: "输入以过滤",
	noMatches: "没有匹配",
	moreAbove: (n) => `↑ 上面还有 ${n} 项`,
	moreBelow: (n) => `↓ 下面还有 ${n} 项`,
	close: "关闭",
	back: "返回",

	maskedHint: "输入时不显示密钥。",
	reviewChanges: "请检查下面的改动。",
	showingLines: (from, to, total) => `第 ${from}-${to} 行，共 ${total} 行`,
	reviewKeys: "↑↓/PageUp/PageDown 滚动 · Enter 应用 · Esc 取消",
	selectKeys: "↑↓ 移动 · Enter 选择 · Esc 取消",

	optionalTitle: "可选扩展",
	optionalHelp: "勾选 = 同步后保持安装。取消勾选已安装的扩展会将其移除。",
	unlistedTitle: "不在预设中的包",
	unlistedHelp: "勾选要保留的包，未勾选的会被移除。",
	unlistedLocal: "不属于预设。未勾选：从 settings.json 删除这一项，本地目录本身保持不动。",
	unlistedInstalled: (kind) => `不属于预设。未勾选：\`pi remove\` 会把它从 settings.json 删除，并删除已安装的 ${kind} 文件。`,
	installedWillBeRemoved: "已安装，将移除",
	installed: "已安装",
	willBeRemoved: "将移除",
	continue: "继续",
	checklistKeys: "↑↓ 移动 · Enter 勾选/继续 · Esc 取消",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
