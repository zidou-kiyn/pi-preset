/**
 * /pi-preset UI text (en / zh): the menu, the language choice, the sync flow
 * and its plan, the models.json template flow, and the font entry. See
 * src/i18n.ts for how a catalog works.
 *
 * The font-install prompt itself (src/font-prompt.ts) is sent to the model
 * and stays English, as do manifest reasons (src/manifest.ts `why`, the
 * superseded-package reasons) and error messages from the file layer.
 */

import { localized } from "./i18n.ts";

const en = {
	// menu
	syncLabel: "Sync preset",
	syncHelp:
		"Packages, config keys (including the chrome-devtools MCP server), and footer. Starts with a checklist of packages outside the preset, shows a full diff, and writes only after confirmation.",
	modelsLabel: "Apply models.json template",
	modelsHelp:
		"Replaces models.json with the preset's OpenAI/Anthropic/DeepSeek providers. Fill in each base URL and API key now or keep placeholders, then pick the default provider and model for settings.json. The old file is kept as models.json.preset-bak.",
	fontLabel: (family: string) => `Install the ${family} font (ask pi)`,
	fontHelp:
		"Sends a prompt to the current model asking it to install the footer's Nerd Font for your user if it is missing and to set it as your terminal's font in the terminal's config (backing it up first). Needs a working model; closes this menu.",
	languageLabel: "Language",
	languageHelp:
		"Language of the preset's own menus and messages. Auto follows the system locale (LC_ALL, LC_MESSAGES, LANG). The PI_PRESET_LANG environment variable (en or zh) overrides this setting.",
	languageAuto: "Auto",
	languageAutoHint: (name: string) => `Auto (${name})`,
	languageAutoHelp: (name: string) => `Follow the system locale (now: ${name}).`,
	languageTitle: "pi-preset: language",
	languageForced: (value: string) => `PI_PRESET_LANG=${value} is set and overrides this choice.`,
	languageSaved: (name: string) => `Language: ${name}`,
	languageUsage: "Usage: /pi-preset language <auto|en|zh>",

	// status line
	configChecking: "Config: checking…",
	configBlocked: (reason: string) => `Config: cannot plan a sync (${reason})`,
	configInSync: "Config: in sync with the preset",
	configToSync: (parts: string) => `Config: ${parts} to sync`,
	packagesToAdd: (n: number) => `${n} package(s) to add`,
	packagesToRemove: (n: number) => `${n} package(s) to remove`,
	keysToSet: (target: string, n: number) => `${target} (${n} key${n === 1 ? "" : "s"})`,
	footerToRetire: "local footer to retire",
	filePermissions: "file permissions",
	listSeparator: ", ",

	// sync flow
	syncCancelled: "pi-preset sync: cancelled, nothing was written",
	syncPlanFailed: (error: string) => `pi-preset sync: could not compute a plan: ${error}`,
	syncNothingApplied: "pi-preset sync: nothing applied",
	syncAlreadyInSync: "pi-preset sync: already in sync",
	syncDryRun: (mode: string) => `pi-preset sync plan (${mode} mode, dry run — no consent possible here):`,
	syncDryRunHint: "Run /pi-preset in interactive mode to apply.",
	syncConfirmTitle: "Apply preset?",
	syncConfirmQuestion: "Apply these changes?",
	restartPackages:
		"Restart pi to load the updated package set — before using /config or pi install in this session, which would persist this session's older packages[] over it.",
	restartFooter: "Restart pi so the footer loads once, from the package.",
	restartToolDisplay: "Restart pi (or /reload) so pi-tool-display releases the bash tool.",
	restartKeybindings: "Restart pi so the ctrl+b keybinding change takes effect.",

	// sync plan (src/plan.ts)
	planRemovePackages: (n: number) => `settings.json packages[]: remove ${n}`,
	planAddPackages: (n: number) => `settings.json packages[]: add ${n}`,
	planSetKeys: (target: string, n: number) => `${target}: set ${n} key(s)`,
	planUnset: "unset",
	planFooterDemote: "local vibrant-footer would double-load: move it aside",
	planPermissions: (n: number) => `permissions: ${n} path(s) readable by other users`,
	planPermissionsWhy: "API keys, MCP config, and session transcripts live here",
	planBlocked: (reason: string) => `blocked: ${reason}`,
	planNothing: "nothing to do",
	planNotArray: '"packages" is not an array; refusing to touch it',
	planAllPresent: (n: number) => `packages: all ${n} already in settings.json`,
	planSomePresent: (n: number) => `packages: ${n} already present`,
	planKeysMatch: (target: string, n: number) => `${target}: ${n} key(s) already match`,
	planLegacySkills: (paths: string) =>
		`skills: ${paths} shadow the bundled copies; run node <pi-preset>/scripts/migrate-vendored.ts to remove them`,
	removeOptionalUnchecked: "optional, unchecked",
	removeNotKept: "not in preset, not kept",

	// apply (src/apply.ts)
	applyPackagesUnchanged: "settings.json: already up to date, nothing written",
	applyPackagesAdded: (n: number) => `settings.json: added ${n} package(s)`,
	applyRemovedGone: "settings.json: packages to remove already gone, nothing written",
	applyRemoved: (n: number, sources: string) => `settings.json: removed ${n} package(s): ${sources}`,
	applyFilesDeleted: (message: string) => `${message}; installed files deleted`,
	applyFilesRemain: (message: string, failures: string) =>
		`${message}; installed files may remain (run \`pi remove <source>\` to clean up): ${failures}`,
	applySetKeys: (target: string, keys: string) => `${target}: set ${keys}`,
	applyPermissionsPrivate: "permissions: already private",
	applyPermissions: (changes: string) => `permissions: ${changes}`,
	applyFooterGone: "footer: local copy already gone",
	applyFooterMoved: (to: string) => `footer: moved local copy to ${to}`,
	applySkipped: (n: number) => `${n} later step(s) skipped after the failure above`,

	// models.json template (src/models-template-run.ts)
	modelsNeedsTui: "pi-preset models: applying the template requires interactive TUI mode; nothing was written",
	modelsLoadFailed: (error: string) => `pi-preset models: cannot load the template: ${error}`,
	modelsReviewSubtitle: "Review the changes. API keys are never shown.",
	modelsTitle: "Apply models.json template",
	modelsFillLabel: "Fill in base URL and API key for each provider",
	modelsFillHelp: (providers: string) =>
		`Prompts for ${providers}. Leave a prompt empty to keep the current value, or the placeholder when there is none.`,
	modelsKeepLabel: "Keep current values / placeholders",
	modelsKeepHelp:
		"Writes the template without prompting. Providers already in models.json keep their endpoint and key; new ones get a placeholder URL and a $ENV_VAR key you can fill in later.",
	baseUrlTitle: (provider: string) => `${provider}: base URL`,
	baseUrlKeepCurrent: (url: string) => `empty = keep current ${url}`,
	baseUrlKeepPlaceholder: (url: string) => `empty = keep placeholder ${url}`,
	apiKeyTitle: (provider: string) => `${provider}: API key`,
	keyKeepReference: (reference: string) => `keep the current reference ${reference}`,
	keyKeepCurrent: "keep the current key",
	keyKeepPlaceholder: (placeholder: string) =>
		`keep the placeholder ${placeholder} (pi then reads the key from that environment variable)`,
	keyHint: (empty: string) =>
		`Hidden while you type. Empty = ${empty}. A value like $NAME is read from that environment variable.`,
	presetDefault: "(preset default)",
	stillPlaceholder: "Still has a placeholder endpoint or key.",
	defaultProviderTitle: "Default provider (settings.json defaultProvider)",
	defaultModelTitle: (provider: string) => `Default model of ${provider} (settings.json defaultModel)`,
	modelsPlanFailed: (error: string) => `pi-preset models: ${error}; nothing was written`,
	modelsAlreadyMatch: "pi-preset models: models.json and the defaults already match; nothing was written",
	modelsConfirmTitle: "Apply models template?",
	modelsCancelled: "pi-preset models: cancelled, nothing was written",
	modelsWriteFailed: (error: string) => `pi-preset models: ${error}`,
	modelsWriteFailedUnknown: "write failed",
	modelsReplaced: (backup: boolean) =>
		`models.json replaced from the template${backup ? " (previous file: models.json.preset-bak)" : ""}. Open /model to load it; no restart needed.`,
	modelsDefaultSet: (model: string) => `Default set to ${model}; it applies from the next pi start.`,
	modelsStillPlaceholders: (entries: string, path: string) =>
		`Still placeholders: ${entries}. Run this again or edit ${path}.`,
	modelsNothingWritten: "pi-preset models: nothing was written",

	// base URL check (src/models-template.ts)
	baseUrlEmpty: "base URL cannot be empty",
	baseUrlInvalid: "base URL must be a valid http:// or https:// URL",
	baseUrlProtocol: "base URL must use http or https",
	baseUrlHostname: "base URL must include a hostname",
	baseUrlCredentials: "base URL must not include a username or password",
	baseUrlQuery: "base URL must not include a query or fragment",

	// models.json template review lines (src/models-template.ts)
	reviewPlaceholder: "placeholder",
	reviewCurrent: "current",
	reviewKeyPlaceholder: "placeholder: read from this environment variable",
	reviewEnvVariable: (current: boolean) => `environment variable${current ? ", current" : ""}`,
	reviewKeyCurrentHidden: "<current key, hidden>",
	reviewKeyEnteredHidden: "<entered, hidden>",
	reviewReplaceModels: "models.json: replace the whole file with the preset template",
	reviewBackup: "previous file kept as models.json.preset-bak",
	reviewUnparsable: (error: string) => `current file could not be parsed (${error}); it is replaced as is`,
	reviewProviderRemoved: (id: string) => `provider ${id} (not in the template, removed)`,
	reviewProvider: (id: string, api: string, models: number) => `${id}  ${api}, ${models} model(s)`,
	reviewModelsMatch: "models.json: already matches the template with these values",
	reviewSettingsChange: (n: number) => `settings.json: change ${n} key(s)`,
	reviewRemoved: "removed",
	reviewDefaultAlready: (provider: string, model: string) => `settings.json: default is already ${provider} / ${model}`,
	reviewStillPlaceholder: (provider: string, fields: string) => `${provider}: ${fields} still a placeholder`,
	reviewFieldsJoin: " and ",

	// font (src/font-prompt.ts; the prompt itself stays English)
	fontNoModel:
		"pi-preset font: no model is selected yet. Set one up first (Apply models.json template, then /model), then pick this entry again.",
	fontQueued: "pi-preset font: queued; it is sent when the current run finishes",
};

type Messages = typeof en;

const zh: Messages = {
	syncLabel: "同步预设",
	syncHelp:
		"同步包、配置项（含 chrome-devtools MCP 服务器）和状态栏。先列出预设之外的包供勾选，再显示完整差异，确认后才写入。",
	modelsLabel: "应用 models.json 模板",
	modelsHelp:
		"用预设的 OpenAI/Anthropic/DeepSeek 提供方替换 models.json。可以现在填写每个 base URL 和 API key，也可以先保留占位值，然后为 settings.json 选择默认提供方和模型。旧文件保存为 models.json.preset-bak。",
	fontLabel: (family) => `安装 ${family} 字体（交给 pi）`,
	fontHelp:
		"向当前模型发送提示，让它在缺少时为当前用户安装状态栏所需的 Nerd Font，并在终端配置里把它设为终端字体（先备份配置）。需要可用的模型；会关闭此菜单。",
	languageLabel: "语言",
	languageHelp:
		"预设自身菜单和提示的语言。自动：跟随系统语言（LC_ALL、LC_MESSAGES、LANG）。设置了环境变量 PI_PRESET_LANG（en 或 zh）时以它为准。",
	languageAuto: "自动",
	languageAutoHint: (name) => `自动（${name}）`,
	languageAutoHelp: (name) => `跟随系统语言（当前：${name}）。`,
	languageTitle: "pi-preset：语言",
	languageForced: (value) => `已设置 PI_PRESET_LANG=${value}，此选择暂不生效。`,
	languageSaved: (name) => `语言：${name}`,
	languageUsage: "用法：/pi-preset language <auto|en|zh>",

	configChecking: "配置：检查中…",
	configBlocked: (reason) => `配置：无法生成同步计划（${reason}）`,
	configInSync: "配置：与预设一致",
	configToSync: (parts) => `配置：待同步（${parts}）`,
	packagesToAdd: (n) => `添加 ${n} 个包`,
	packagesToRemove: (n) => `移除 ${n} 个包`,
	keysToSet: (target, n) => `${target} ${n} 项`,
	footerToRetire: "停用本地状态栏",
	filePermissions: "修正文件权限",
	listSeparator: "、",

	syncCancelled: "pi-preset 同步：已取消，未写入任何内容",
	syncPlanFailed: (error) => `pi-preset 同步：无法生成计划：${error}`,
	syncNothingApplied: "pi-preset 同步：未应用任何改动",
	syncAlreadyInSync: "pi-preset 同步：已同步",
	syncDryRun: (mode) => `pi-preset 同步计划（${mode} 模式，仅预览——此处无法确认）：`,
	syncDryRunHint: "在交互模式下运行 /pi-preset 以应用。",
	syncConfirmTitle: "应用预设？",
	syncConfirmQuestion: "应用这些改动？",
	restartPackages:
		"请重启 pi 以加载新的包列表——在本会话里使用 /config 或 pi install 之前就要重启，否则本会话旧的 packages[] 会覆盖刚才的改动。",
	restartFooter: "请重启 pi，让状态栏只从包里加载一次。",
	restartToolDisplay: "请重启 pi（或 /reload），让 pi-tool-display 释放 bash 工具。",
	restartKeybindings: "请重启 pi，让 ctrl+b 快捷键的改动生效。",

	planRemovePackages: (n) => `settings.json packages[]：移除 ${n} 个`,
	planAddPackages: (n) => `settings.json packages[]：添加 ${n} 个`,
	planSetKeys: (target, n) => `${target}：设置 ${n} 项`,
	planUnset: "未设置",
	planFooterDemote: "本地 vibrant-footer 会重复加载：将其移走",
	planPermissions: (n) => `权限：${n} 个路径可被其他用户读取`,
	planPermissionsWhy: "这里存放 API key、MCP 配置和会话记录",
	planBlocked: (reason) => `已阻止：${reason}`,
	planNothing: "无需改动",
	planNotArray: '"packages" 不是数组，不予改动',
	planAllPresent: (n) => `packages：全部 ${n} 个已在 settings.json 中`,
	planSomePresent: (n) => `packages：已有 ${n} 个`,
	planKeysMatch: (target, n) => `${target}：${n} 项已一致`,
	planLegacySkills: (paths) =>
		`skills：${paths} 会遮蔽预设自带的副本；运行 node <pi-preset>/scripts/migrate-vendored.ts 移除它们`,
	removeOptionalUnchecked: "可选，未勾选",
	removeNotKept: "不在预设中，未保留",

	applyPackagesUnchanged: "settings.json：已是最新，未写入",
	applyPackagesAdded: (n) => `settings.json：已添加 ${n} 个包`,
	applyRemovedGone: "settings.json：要移除的包已不存在，未写入",
	applyRemoved: (n, sources) => `settings.json：已移除 ${n} 个包：${sources}`,
	applyFilesDeleted: (message) => `${message}；已删除安装的文件`,
	applyFilesRemain: (message, failures) =>
		`${message}；安装的文件可能还在（运行 \`pi remove <source>\` 清理）：${failures}`,
	applySetKeys: (target, keys) => `${target}：已设置 ${keys}`,
	applyPermissionsPrivate: "权限：已是私有",
	applyPermissions: (changes) => `权限：${changes}`,
	applyFooterGone: "状态栏：本地副本已不存在",
	applyFooterMoved: (to) => `状态栏：本地副本已移到 ${to}`,
	applySkipped: (n) => `上面的步骤失败，跳过了之后的 ${n} 个步骤`,

	modelsNeedsTui: "pi-preset 模型：应用模板需要交互式 TUI 模式；未写入任何内容",
	modelsLoadFailed: (error) => `pi-preset 模型：无法加载模板：${error}`,
	modelsReviewSubtitle: "请检查改动。API key 始终不显示。",
	modelsTitle: "应用 models.json 模板",
	modelsFillLabel: "为每个提供方填写 base URL 和 API key",
	modelsFillHelp: (providers) => `依次询问 ${providers}。留空则保留当前值，没有当前值时保留占位值。`,
	modelsKeepLabel: "保留当前值 / 占位值",
	modelsKeepHelp:
		"不询问，直接写入模板。models.json 里已有的提供方保留其地址和密钥；新的提供方使用占位 URL 和 $ENV_VAR 形式的密钥，之后再填。",
	baseUrlTitle: (provider) => `${provider}：base URL`,
	baseUrlKeepCurrent: (url) => `留空 = 保留当前值 ${url}`,
	baseUrlKeepPlaceholder: (url) => `留空 = 保留占位值 ${url}`,
	apiKeyTitle: (provider) => `${provider}：API key`,
	keyKeepReference: (reference) => `保留当前引用 ${reference}`,
	keyKeepCurrent: "保留当前密钥",
	keyKeepPlaceholder: (placeholder) => `保留占位值 ${placeholder}（pi 会从这个环境变量读取密钥）`,
	keyHint: (empty) => `输入时不显示。留空 = ${empty}。$NAME 形式的值会从该环境变量读取。`,
	presetDefault: "（预设默认）",
	stillPlaceholder: "地址或密钥仍是占位值。",
	defaultProviderTitle: "默认提供方（settings.json defaultProvider）",
	defaultModelTitle: (provider) => `${provider} 的默认模型（settings.json defaultModel）`,
	modelsPlanFailed: (error) => `pi-preset 模型：${error}；未写入任何内容`,
	modelsAlreadyMatch: "pi-preset 模型：models.json 和默认设置已一致；未写入任何内容",
	modelsConfirmTitle: "应用模型模板？",
	modelsCancelled: "pi-preset 模型：已取消，未写入任何内容",
	modelsWriteFailed: (error) => `pi-preset 模型：${error}`,
	modelsWriteFailedUnknown: "写入失败",
	modelsReplaced: (backup) =>
		`已用模板替换 models.json${backup ? "（旧文件：models.json.preset-bak）" : ""}。打开 /model 即可加载，无需重启。`,
	modelsDefaultSet: (model) => `默认模型已设为 ${model}，下次启动 pi 时生效。`,
	modelsStillPlaceholders: (entries, path) => `仍是占位值：${entries}。可再次运行，或编辑 ${path}。`,
	modelsNothingWritten: "pi-preset 模型：未写入任何内容",

	baseUrlEmpty: "base URL 不能为空",
	baseUrlInvalid: "base URL 必须是有效的 http:// 或 https:// 地址",
	baseUrlProtocol: "base URL 必须使用 http 或 https",
	baseUrlHostname: "base URL 必须包含主机名",
	baseUrlCredentials: "base URL 不能包含用户名或密码",
	baseUrlQuery: "base URL 不能包含查询参数或片段",

	reviewPlaceholder: "占位值",
	reviewCurrent: "当前值",
	reviewKeyPlaceholder: "占位值：从这个环境变量读取",
	reviewEnvVariable: (current) => `环境变量${current ? "，当前值" : ""}`,
	reviewKeyCurrentHidden: "<当前密钥，已隐藏>",
	reviewKeyEnteredHidden: "<已输入，已隐藏>",
	reviewReplaceModels: "models.json：整个文件替换为预设模板",
	reviewBackup: "旧文件保存为 models.json.preset-bak",
	reviewUnparsable: (error) => `当前文件无法解析（${error}），将直接替换`,
	reviewProviderRemoved: (id) => `提供方 ${id}（不在模板中，将移除）`,
	reviewProvider: (id, api, models) => `${id}  ${api}，${models} 个模型`,
	reviewModelsMatch: "models.json：按这些值已与模板一致",
	reviewSettingsChange: (n) => `settings.json：修改 ${n} 项`,
	reviewRemoved: "移除",
	reviewDefaultAlready: (provider, model) => `settings.json：默认已是 ${provider} / ${model}`,
	reviewStillPlaceholder: (provider, fields) => `${provider}：${fields} 仍是占位值`,
	reviewFieldsJoin: " 和 ",

	fontNoModel: "pi-preset 字体：还没有选择模型。请先设置一个（应用 models.json 模板，然后 /model），再选这一项。",
	fontQueued: "pi-preset 字体：已排队，当前运行结束后发送",
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
