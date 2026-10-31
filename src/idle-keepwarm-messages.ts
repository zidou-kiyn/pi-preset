/**
 * idle-keepwarm UI text (en / zh): its plain status line, the pause notes
 * the footer shows, and its warning. See src/i18n.ts for how a catalog works.
 * A note is translated when warming pauses, so it keeps that language until
 * the next one.
 */

import { localized } from "./i18n.ts";

const en = {
	status: (note: string) => `keepwarm: ${note}`,
	cacheLeft: (left: string) => `cache ${left}`,
	cacheExpired: "cache expired",
	warming: "warming",
	nextWarm: (clock: string, warms: number) => `warm ${clock}${warms > 0 ? ` (${warms}x)` : ""}`,

	idleLimit: "idle limit reached",
	warmLimit: (warms: number) => `warm stopped (${warms}x)`,
	unlimitedOn: "keepwarm: no refresh limit for this session",
	unlimitedOff: (max: number) => `keepwarm: refresh limit back to ${max}`,
	noLimitConfigured: "keepwarm: no refresh limit set (PI_PRESET_KEEPWARM_MAX_WARMS=off)",
	modelChanged: "model changed",
	expiredResumes: "cache expired, resumes on next message",
	refreshFailed: (reason: string) => `refresh failed (${reason}), resumes on next message`,
	cacheMiss: (read: number, wrote: number) =>
		`refresh missed the cache (read ${read}, wrote ${wrote} tokens); stopped until the next message`,
	stoppedAfterMiss: "stopped after a cache miss",
	compacted: "compacted",
	treeNavigation: "tree navigation",
};

type Messages = typeof en;

const zh: Messages = {
	status: (note) => `keepwarm：${note}`,
	cacheLeft: (left) => `缓存 ${left}`,
	cacheExpired: "缓存已过期",
	warming: "预热中",
	nextWarm: (clock, warms) => `预热 ${clock}${warms > 0 ? `（${warms} 次）` : ""}`,

	idleLimit: "已达空闲上限",
	warmLimit: (warms) => `预热已停（${warms} 次）`,
	unlimitedOn: "keepwarm：本会话不限预热轮次",
	unlimitedOff: (max) => `keepwarm：预热轮次恢复上限 ${max} 次`,
	noLimitConfigured: "keepwarm：未设轮次上限（PI_PRESET_KEEPWARM_MAX_WARMS=off）",
	modelChanged: "模型已切换",
	expiredResumes: "缓存已过期，下条消息后恢复",
	refreshFailed: (reason) => `刷新失败（${reason}），下条消息后恢复`,
	cacheMiss: (read, wrote) => `刷新未命中缓存（读取 ${read}、写入 ${wrote} tokens），下条消息前不再预热`,
	stoppedAfterMiss: "缓存未命中，已停止",
	compacted: "上下文已压缩",
	treeNavigation: "已在会话树中跳转",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
