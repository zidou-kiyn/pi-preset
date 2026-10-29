/**
 * /secret-redact UI text (en / zh). See src/i18n.ts. Block reasons the model
 * reads are English and live in the extension.
 */

import { localized } from "../i18n.ts";

const en = {
	title: "secret-redact",
	statusOn: "On: secrets in tool results are replaced before the model sees them",
	statusOff: "Off: tool results reach the model unchanged",
	statusEnvOff: "Off for this process (PI_PRESET_SECRET_REDACT=off)",
	replaced: (total: number, top: string) => (total === 0 ? "Nothing replaced yet in this pi process" : `Replaced in this pi process: ${total} (${top})`),
	rules: (rules: number, left: number, version: string) => `Rules: ${rules} from Betterleaks ${version} (${left} left out: identifiers, path-only)`,
	known: (count: number, sources: string) => (count === 0 ? "Known values: none found" : `Known values: ${count} (${sources})`),
	slowRules: (ids: string) => `Switched off as too slow: ${ids}`,
	rulesError: (error: string) => `Rules could not be loaded: ${error}`,
	itemEnabled: "Redaction",
	enabledHelp: "Replace secrets in every tool result (read, bash, grep, MCP tools, codemode) with [REDACTED:kind-n]. write, edit, and apply_patch put the real value back; commands and remote tools refuse placeholders.",
	itemNamed: "Values named like secrets",
	namedHelp: "Also replace values whose name says they are secret (password = ..., API_KEY: ..., token=...). Catches more, and hides some ordinary values the agent may need.",
	itemReload: "Reload known values",
	reloadHelp: "Read the environment and auth.json / models.json / mcp.json again.",
	reloaded: (count: number) => `Known values reloaded: ${count}`,
	on: "on",
	off: "off",
	close: "close",
	savedEnabled: (on: boolean) => (on ? "Redaction is on" : "Redaction is off"),
	savedNamed: (on: boolean) => (on ? "Values named like secrets are replaced too" : "Only recognised secrets and known values are replaced"),
};

type Messages = typeof en;

const zh: Messages = {
	title: "secret-redact 脱敏",
	statusOn: "已开启：工具结果里的密钥在模型看到之前被替换",
	statusOff: "已关闭：工具结果原样交给模型",
	statusEnvOff: "本进程已关闭（PI_PRESET_SECRET_REDACT=off）",
	replaced: (total, top) => (total === 0 ? "本 pi 进程还没有替换过" : `本 pi 进程已替换：${total} 处（${top}）`),
	rules: (rules, left, version) => `规则：Betterleaks ${version} 的 ${rules} 条（另有 ${left} 条未用：标识符、仅匹配路径）`,
	known: (count, sources) => (count === 0 ? "已知值：没有找到" : `已知值：${count} 个（${sources}）`),
	slowRules: (ids) => `因太慢已停用：${ids}`,
	rulesError: (error) => `规则加载失败：${error}`,
	itemEnabled: "脱敏",
	enabledHelp: "把所有工具结果（read、bash、grep、MCP 工具、codemode）里的密钥换成 [REDACTED:类型-编号]。write、edit、apply_patch 写文件时换回真实值；命令和远程工具里出现占位符会被拒绝。",
	itemNamed: "按名字识别的值",
	namedHelp: "名字表明是密钥的值也替换（password = …、API_KEY: …、token=…）。能抓到更多，但也会遮住一些 agent 需要的普通值。",
	itemReload: "重新读取已知值",
	reloadHelp: "重新读取环境变量和 auth.json / models.json / mcp.json。",
	reloaded: (count) => `已知值已重新读取：${count} 个`,
	on: "开",
	off: "关",
	close: "关闭",
	savedEnabled: (on) => (on ? "脱敏已开启" : "脱敏已关闭"),
	savedNamed: (on) => (on ? "按名字识别的值也会替换" : "只替换识别出的密钥和已知值"),
};

export const catalogs = { en, zh };
export const messages = localized(catalogs);
