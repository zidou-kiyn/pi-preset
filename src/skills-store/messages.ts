/**
 * /skills UI text (en / zh). See src/i18n.ts for how a catalog works.
 *
 * Not here, and English on purpose: the `skills` tool's description and
 * results, skill contents, and the curated list's `what` lines as the tool
 * reports them (the menu translates those through `curatedWhat`).
 */

import { localized } from "../i18n.ts";
import type { Level } from "./state.ts";

const en = {
	title: "Skills store",
	storeStats: (bundled: number, local: number) => `Store: ${bundled} bundled · ${local} local`,
	enabledHere: (session: number, project: number, always: number) =>
		`Enabled here: ${session} session · ${project} project · ${always} always`,
	pendingReload: "Enabled through the tool this turn; listed for the model after the next /reload.",
	cwdLine: (cwd: string) => `Project: ${cwd}`,

	levelName: (level: Level | undefined): string =>
		level === "always" ? "always" : level === "project" ? "project" : level === "session" ? "session" : "off",
	originName: (origin: "bundled" | "local"): string => (origin === "bundled" ? "bundled with the preset" : "local"),
	installedFrom: (source: string, commit: string | undefined) => `Installed from ${source}${commit ? ` @ ${commit.slice(0, 7)}` : ""}`,
	shadows: "A bundled skill of the same name is hidden by this one.",
	groupHint: (on: number, total: number, origin: "bundled" | "local"): string =>
		`${on}/${total} on${origin === "bundled" ? " · bundled" : ""}`,
	groupHelp: "The whole group: enable or turn off every skill in it, update or remove it.",
	actionsHeading: "Store",
	actionsHelp: "Find, install, search, update, import.",
	enableAllLabel: (level: Level): string =>
		level === "session" ? "Enable all for this session" : level === "project" ? "Enable all in this project" : "Enable all always",
	offAllLabel: "Turn all off",
	updateAllLabel: "Update all",
	removeAllLabel: "Remove the group from the store",
	enabledAll: (group: string, level: Level) => `${group}: every skill ${en.levelName(level)}.`,
	confirmRemoveAll: (group: string, count: number) => `Delete ${group} (${count} skills) from the store?`,

	findLabel: "Let the agent find one…",
	findHelp: "Describe what you need in your own words. The agent derives the queries, searches the store, the recommended list, and skills.sh, and comes back with a recommendation. Closes this menu.",
	findPrompt: "What do you need a skill for?",
	installLabel: "Install from GitHub or a path…",
	installHelp: "owner/repo, owner/repo@skill, a GitHub URL, or a local directory. Files are copied into the store; nothing is run.",
	curatedLabel: "Recommended skills…",
	curatedHelp: "A short list of well-known skills the preset vouches for. Each is fetched from its repository when you pick it.",
	searchLabel: "Search skills.sh…",
	searchHelp: "The registry `npx skills find` searches. Results show install counts; pick one to install it.",
	updatesLabel: "Check updates",
	updatesHelp: "Compares each installed skill's commit with its repository (one ls-remote each, no clone).",
	importLabel: (count: number) => `Move ${count} skill(s) from pi's directories into the store…`,
	importHelp:
		"~/.pi/agent/skills and ~/.agents/skills are always loaded by pi. Moving a skill here makes it on-demand; the original goes to a backup directory.",

	useLabel: "Use now",
	useHelp: "Sends the skill into this conversation at once, like /skill:name. No reload; not added to the skill list.",
	enableLabel: (level: Level): string =>
		level === "session" ? "Enable for this session" : level === "project" ? "Enable in this project" : "Enable always",
	enableHelp: (level: Level): string =>
		level === "session"
			? "Listed for the model until pi exits (kept across /new). Reloads now."
			: level === "project"
				? "Listed whenever pi runs in this directory. Reloads now."
				: "Listed in every session, like a skill in ~/.pi/agent/skills. Reloads now.",
	offLabel: "Turn off",
	offHelp: "Removed from the skill list at the next reload.",
	showLabel: "Show SKILL.md",
	showHelp: "Read-only.",
	removeLabel: "Remove from the store",
	removeHelp: "Deletes the skill directory. Bundled skills cannot be removed.",
	checkLabel: "Check for an update",
	checkHelp: "One git ls-remote against the recorded repository.",
	updateLabel: "Update",
	updateHelp: "Fetches the repository again and replaces the files.",

	installPrompt: "Source (owner/repo, owner/repo@skill, URL, or path)",
	searchPrompt: "Search skills.sh for",
	pickSkill: "Which skill to install?",
	pickSkillHelp: (source: string) => `${source} holds several skills.`,
	installAll: (count: number) => `All ${count}`,
	confirmInstall: (name: string, source: string, replaced: boolean) =>
		`${replaced ? "Replace" : "Install"} ${name} from ${source}?`,
	confirmRemove: (name: string) => `Delete ${name} from the store?`,
	confirmImport: (names: string, backup: string) => `Move into the store: ${names}\n\nOriginals go to ${backup}`,
	importOfferTitle: "Skills in pi's directories",
	importOfferText: (names: string) =>
		`${names}\n\nThese load in every session. Move them into the store to enable them on demand instead? Originals are kept in a backup directory. You can do this later from the menu.`,
	installs: (count: number) => `${count} installs`,
	searching: (query: string) => `Searching skills.sh for "${query}"…`,
	fetching: (source: string) => `Fetching ${source}…`,

	enabled: (name: string, level: Level) => `${name}: ${en.levelName(level)}.`,
	enabledNoReload: (name: string, level: Level) => `${name}: ${en.levelName(level)}. Takes effect at the next /reload (the agent is busy).`,
	disabled: (name: string) => `${name}: off. Leaves the skill list at the next /reload.`,
	used: (name: string) => `${name} sent to the conversation.`,
	installed: (names: string) => `Installed: ${names}. Enable it from the list, or use it now.`,
	removed: (name: string) => `${name} removed.`,
	upToDate: (name: string) => `${name} is up to date.`,
	updateAvailable: (name: string) => `${name}: an update is available.`,
	updatesSummary: (outdated: string[], checked: number, errors: string[]) =>
		[
			outdated.length > 0 ? `Updates: ${outdated.join(", ")}` : `All ${checked} up to date`,
			...(errors.length > 0 ? [`Not checkable: ${errors.join(", ")}`] : []),
		].join(" · "),
	nothingToCheck: "No installed skill records a repository.",
	imported: (names: string) => `Moved into the store: ${names}. Reloading.`,
	noResults: "No results.",
	noSkills: "The store is empty. Install one, or pick a recommended skill.",
	notFound: (name: string) => `No skill named ${name} in the store.`,
	needsIdle: "Wait for the agent to finish before reloading.",
	cancelled: "Cancelled.",
	skillList: "Skills in the store",
	backToList: "back",

	curatedWhat: (_name: string, what: string): string => what,
	unknownSubcommand: (sub: string) => `Unknown subcommand "${sub}". Use list, use <name>, enable <name> [session|project|always], off <name>, install <source>, search <query>, find <what you need>.`,
	listHeader: "Skills store (level · name · description)",
	noUi: "Open /skills in interactive mode to manage the store.",
};

type Messages = typeof en;

/** Chinese one-liners for the curated list, by name; falls back to the English `what`. */
const CURATED_ZH: Record<string, string> = {
	officecli: "通过 officecli 二进制创建、检查、修改 .docx/.xlsx/.pptx（首次用时自动安装）；DOM 级编辑，自带 help 规范",
	docx: "创建和编辑 Word 文档，支持修订与批注（Anthropic；专有许可，所以拉取而非内置）",
	xlsx: "创建和分析电子表格，含公式与格式（Anthropic；专有许可）",
	pptx: "创建和编辑 PowerPoint 演示文稿（Anthropic；专有许可）",
	pdf: "读取、填写、合并、创建 PDF（Anthropic；专有许可）",
	"systematic-debugging": "superpowers 的系统化排错：先复现、再定位、再改，不乱猜",
	"vercel-react-best-practices": "Vercel 的 React / Next.js 最佳实践",
};

const zh: Messages = {
	title: "Skill 仓库",
	storeStats: (bundled, local) => `仓库：内置 ${bundled} 个 · 本地 ${local} 个`,
	enabledHere: (session, project, always) => `此处已启用：会话 ${session} · 本项目 ${project} · 始终 ${always}`,
	pendingReload: "本轮由工具启用；下次 /reload 后模型才会在列表里看到。",
	cwdLine: (cwd) => `项目：${cwd}`,

	levelName: (level) => (level === "always" ? "始终" : level === "project" ? "本项目" : level === "session" ? "会话" : "关闭"),
	originName: (origin) => (origin === "bundled" ? "预置内置" : "本地"),
	installedFrom: (source, commit) => `安装自 ${source}${commit ? ` @ ${commit.slice(0, 7)}` : ""}`,
	shadows: "同名的内置 skill 被这个本地版本覆盖。",
	groupHint: (on, total, origin) => `已启用 ${on}/${total}${origin === "bundled" ? " · 内置" : ""}`,
	groupHelp: "整组操作：一起启用或关闭、更新、删除。",
	actionsHeading: "仓库",
	actionsHelp: "找、装、搜、更新、导入。",
	enableAllLabel: (level) => (level === "session" ? "整组本会话启用" : level === "project" ? "整组本项目启用" : "整组始终启用"),
	offAllLabel: "整组关闭",
	updateAllLabel: "整组更新",
	removeAllLabel: "从仓库删除整组",
	enabledAll: (group, level) => `${group}：全部${zh.levelName(level)}。`,
	confirmRemoveAll: (group, count) => `从仓库删除 ${group}（${count} 个 skill）？`,

	findLabel: "让 agent 帮我找…",
	findHelp: "用自己的话描述要做什么。agent 自己拟搜索词，搜仓库、推荐清单和 skills.sh，再给出推荐。关闭本菜单。",
	findPrompt: "想找什么用途的 skill？",
	installLabel: "从 GitHub 或路径安装…",
	installHelp: "owner/repo、owner/repo@skill、GitHub 链接或本地目录。只把文件复制进仓库，不执行任何东西。",
	curatedLabel: "推荐的 skill…",
	curatedHelp: "preset 认可的一小份知名 skill 清单。选中后从其仓库拉取。",
	searchLabel: "搜索 skills.sh…",
	searchHelp: "`npx skills find` 用的那个注册表。结果带安装量；选一个即安装。",
	updatesLabel: "检查更新",
	updatesHelp: "把每个已安装 skill 的 commit 和它的仓库比对（每个一次 ls-remote，不克隆）。",
	importLabel: (count) => `把 pi 目录里的 ${count} 个 skill 搬进仓库…`,
	importHelp: "~/.pi/agent/skills 和 ~/.agents/skills 是 pi 始终加载的目录。搬进仓库后变为按需启用；原目录移入备份目录。",

	useLabel: "现在就用",
	useHelp: "立刻把 skill 发进当前对话，等同 /skill:name。不 reload，也不进 skill 列表。",
	enableLabel: (level) => (level === "session" ? "本会话启用" : level === "project" ? "本项目启用" : "始终启用"),
	enableHelp: (level) =>
		level === "session"
			? "直到 pi 退出都在模型的 skill 列表里（跨 /new 保留）。立即 reload。"
			: level === "project"
				? "在这个目录运行 pi 时都在列表里。立即 reload。"
				: "每个会话都在列表里，等同放进 ~/.pi/agent/skills。立即 reload。",
	offLabel: "关闭",
	offHelp: "下次 reload 后从 skill 列表移除。",
	showLabel: "查看 SKILL.md",
	showHelp: "只读。",
	removeLabel: "从仓库删除",
	removeHelp: "删除该 skill 目录。内置 skill 不能删。",
	checkLabel: "检查更新",
	checkHelp: "对记录的仓库做一次 git ls-remote。",
	updateLabel: "更新",
	updateHelp: "重新拉取仓库并替换文件。",

	installPrompt: "来源（owner/repo、owner/repo@skill、链接或路径）",
	searchPrompt: "在 skills.sh 搜索",
	pickSkill: "安装哪个 skill？",
	pickSkillHelp: (source) => `${source} 里有多个 skill。`,
	installAll: (count) => `全部 ${count} 个`,
	confirmInstall: (name, source, replaced) => `${replaced ? "替换" : "安装"} ${name}（来自 ${source}）？`,
	confirmRemove: (name) => `从仓库删除 ${name}？`,
	confirmImport: (names, backup) => `搬进仓库：${names}\n\n原目录移至 ${backup}`,
	importOfferTitle: "pi 目录里的 skill",
	importOfferText: (names) =>
		`${names}\n\n它们每个会话都会加载。要搬进仓库改为按需启用吗？原目录会保留在备份目录。以后也可以在菜单里做。`,
	installs: (count) => `${count} 次安装`,
	searching: (query) => `正在 skills.sh 搜索“${query}”…`,
	fetching: (source) => `正在拉取 ${source}…`,

	enabled: (name, level) => `${name}：${zh.levelName(level)}。`,
	enabledNoReload: (name, level) => `${name}：${zh.levelName(level)}。agent 正忙，下次 /reload 生效。`,
	disabled: (name) => `${name}：已关闭。下次 /reload 后离开 skill 列表。`,
	used: (name) => `${name} 已发进对话。`,
	installed: (names) => `已安装：${names}。可在列表里启用，或现在就用。`,
	removed: (name) => `${name} 已删除。`,
	upToDate: (name) => `${name} 已是最新。`,
	updateAvailable: (name) => `${name}：有更新。`,
	updatesSummary: (outdated, checked, errors) =>
		[
			outdated.length > 0 ? `有更新：${outdated.join("、")}` : `${checked} 个都是最新`,
			...(errors.length > 0 ? [`无法检查：${errors.join("、")}`] : []),
		].join(" · "),
	nothingToCheck: "没有记录了仓库来源的已安装 skill。",
	imported: (names) => `已搬进仓库：${names}。正在 reload。`,
	noResults: "没有结果。",
	noSkills: "仓库是空的。安装一个，或从推荐里挑。",
	notFound: (name) => `仓库里没有名为 ${name} 的 skill。`,
	needsIdle: "等 agent 完成后再 reload。",
	cancelled: "已取消。",
	skillList: "仓库里的 skill",
	backToList: "返回",

	curatedWhat: (name, what) => CURATED_ZH[name] ?? what,
	unknownSubcommand: (sub) =>
		`未知子命令“${sub}”。可用：list、use <name>、enable <name> [session|project|always]、off <name>、install <source>、search <query>、find <想做什么>。`,
	listHeader: "Skill 仓库（级别 · 名称 · 描述）",
	noUi: "在交互模式下打开 /skills 管理仓库。",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
