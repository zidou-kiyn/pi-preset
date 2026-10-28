/**
 * /trellis-lite UI text (en / zh). See src/i18n.ts for how a catalog works.
 *
 * Not here, and English on purpose: the project-memory section, injected
 * specs, the skills and the migration prompt (all read by the model), and the
 * migration plan, which is also the output of the CLI the agent runs.
 */

import { localized } from "../i18n.ts";

const en = {
	legacyPausedNotice: (assets: string) =>
		`trellis-lite is paused: old Trellis pi assets are installed (${assets}). Run /trellis-lite-migrate to migrate.`,
	notProject: "Not a Trellis project (no .trellis/ up to the repository root).",
	project: (root: string) => `Project: ${root}`,
	paused: (assets: string) => `Paused: old Trellis assets are installed (${assets}).`,
	sectionStats: (chars: number, specs: number, injectionOff: boolean) =>
		`project-memory section: ${chars} chars · path-scoped specs: ${specs}${injectionOff ? " (injection off)" : ""}`,
	noDeveloper: "No developer set yet (.trellis/.developer): initialize to start a journal.",
	specsInContext: (specs: string) => `Specs in context this session: ${specs}`,

	developerPrompt: "Developer name (journal directory)",
	noDeveloperName: "No developer name given; nothing created.",
	alreadyInitialized: (root: string) => `${root} is already initialized.`,
	stepAppend: (path: string) => `append ${path}`,
	stepCreate: (path: string) => `create ${path}`,
	initConfirmTitle: "Initialize trellis-lite?",
	initDone: (steps: readonly string[]) =>
		`${steps.join("; ")}. Not committed (see git status). Run /reload to load the trellis-lite skills.`,

	initLabel: "Initialize trellis-lite here",
	initHelp:
		"Creates the missing .trellis/ skeleton (spec indexes, workspace, journal) after showing the file list. Nothing is committed.",
	migrateLabel: "Migrate from Trellis with the agent",
	migrateHelp: "Sends the migration prompt: dry run first, then asks before every change. Closes this menu.",
	planLabel: "Show the migration plan",
	planHelp: "Read-only: what the migration would move, keep, and remove.",
	sectionLabel: "Show the project-memory section",
	sectionHelp: "The exact text added to the system prompt in this project.",
	planTitle: "Migration plan (read-only)",
	sectionTitle: (chars: number) => `project-memory section (${chars} chars)`,

	migrateHint: "Run /trellis-lite-migrate to carry it out with the agent.",
	nothingToMigrate: "Not a Trellis project; nothing to migrate.",
	unknownSubcommand: (sub: string) => `Unknown subcommand "${sub}". Use status, init, or migrate.`,
};

type Messages = typeof en;

const zh: Messages = {
	legacyPausedNotice: (assets) =>
		`trellis-lite 已暂停：项目里装有旧的 Trellis pi 资源（${assets}）。运行 /trellis-lite-migrate 进行迁移。`,
	notProject: "不是 Trellis 项目（直到仓库根目录都没有 .trellis/）。",
	project: (root) => `项目：${root}`,
	paused: (assets) => `已暂停：项目里装有旧的 Trellis 资源（${assets}）。`,
	sectionStats: (chars, specs, injectionOff) =>
		`project-memory 段落：${chars} 字符 · 按路径生效的规范：${specs}${injectionOff ? "（注入已关闭）" : ""}`,
	noDeveloper: "尚未设置开发者（.trellis/.developer）：初始化后即可开始写日志。",
	specsInContext: (specs) => `本会话已加入上下文的规范：${specs}`,

	developerPrompt: "开发者名称（日志目录名）",
	noDeveloperName: "未填写开发者名称，未创建任何内容。",
	alreadyInitialized: (root) => `${root} 已初始化。`,
	stepAppend: (path) => `追加 ${path}`,
	stepCreate: (path) => `创建 ${path}`,
	initConfirmTitle: "初始化 trellis-lite？",
	initDone: (steps) => `${steps.join("；")}。未提交（见 git status）。运行 /reload 加载 trellis-lite 技能。`,

	initLabel: "在此初始化 trellis-lite",
	initHelp: "列出文件后创建缺少的 .trellis/ 骨架（规范索引、工作区、日志）。不会提交。",
	migrateLabel: "让 agent 从 Trellis 迁移",
	migrateHelp: "发送迁移提示：先预演，之后每处改动都先询问。会关闭此菜单。",
	planLabel: "查看迁移计划",
	planHelp: "只读：迁移会移动、保留和删除哪些内容。",
	sectionLabel: "查看 project-memory 段落",
	sectionHelp: "本项目里加入系统提示词的原文。",
	planTitle: "迁移计划（只读）",
	sectionTitle: (chars) => `project-memory 段落（${chars} 字符）`,

	migrateHint: "运行 /trellis-lite-migrate，让 agent 执行迁移。",
	nothingToMigrate: "不是 Trellis 项目，无需迁移。",
	unknownSubcommand: (sub) => `未知子命令 "${sub}"。可用：status、init、migrate。`,
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
