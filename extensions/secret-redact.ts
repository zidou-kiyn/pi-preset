/**
 * secret-redact — keep secrets in tool results away from the model.
 *
 * Why: most leaks come from the agent's own tools, not from what the user
 * types: a `read` of .env, a `bash` that prints a config or the environment,
 * an MCP tool echoing a token. Whatever a tool returns goes to the model
 * provider and into the session file.
 *
 * How: every tool result (nested codemode calls included) is scanned before
 * the model sees it, and each secret is replaced by a placeholder such as
 * `[REDACTED:github-pat-1]`. What counts as a secret:
 *   - the Betterleaks rule set (vendor/betterleaks-rules, MIT; ~420 token
 *     formats: cloud keys, API tokens, private keys, credentials in URLs);
 *   - values pi itself knows: secret-looking environment variables and the
 *     keys in auth.json, models.json, and mcp.json;
 *   - optionally (/secret-redact) values whose name says secret.
 * The same value keeps its placeholder for the life of the pi process. The
 * values stay in memory; the transcript holds placeholders only.
 *
 * write, edit, and apply_patch put the real value back, so editing a file
 * that holds a secret keeps it intact. bash, powershell, and MCP tools refuse
 * a call with a placeholder in it: they never get values back, since a
 * command could send one anywhere.
 *
 * This hides secrets from accidental exposure; it is not a boundary. An
 * agent that transforms the output (base64, rev) gets around it, and so does
 * reading a secret that matches no rule and is not known.
 *
 * Termius results also carry the termius server's own `[redacted:...]`
 * markers for vault secrets (vendor/termius-mcp/termius/redact.py); those
 * are never restored.
 *
 * Env:     PI_PRESET_SECRET_REDACT=off   disable for this process
 * Command: /secret-redact                status, on/off, named values
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuItem, type Notice, showMenu } from "../src/preset-menu.ts";
import { Detector, type KnownValue } from "../src/secret-redact/detect.ts";
import { handleToolCall, RepeatMemory, redactToolResult } from "../src/secret-redact/hooks.ts";
import { collectKnownSecrets } from "../src/secret-redact/known.ts";
import { messages } from "../src/secret-redact/messages.ts";
import { Redactor } from "../src/secret-redact/redactor.ts";
import { loadRuleSet, type RuleSet } from "../src/secret-redact/rules.ts";
import { envDisabled, readSettings, type SecretRedactSettings, writeSettings } from "../src/secret-redact/settings.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE_FILE = join(PACKAGE_ROOT, "vendor", "betterleaks-rules", "config", "betterleaks.toml");
const KNOWN_TTL_MS = 60_000;

function rulesVersion(): string {
	try {
		// vendor/UPSTREAM.json records the vendored release.
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "vendor", "UPSTREAM.json"), "utf8"));
		return `v${manifest.packages["betterleaks-rules"].version}`;
	} catch {
		return "";
	}
}

/** Where a known value came from, for the status line. */
function sourceOf(label: string): string {
	if (label.startsWith("env-")) return "env";
	if (label.startsWith("pi-auth-")) return "auth.json";
	if (label.startsWith("pi-models-")) return "models.json";
	if (label.startsWith("pi-mcp-")) return "mcp.json";
	return label;
}

export default function secretRedactExtension(pi: ExtensionAPI): void {
	let settings: SecretRedactSettings = readSettings();
	let rules: RuleSet | undefined;
	let rulesError: string | undefined;
	try {
		rules = loadRuleSet(RULE_FILE);
	} catch (error) {
		rulesError = (error as Error).message;
	}
	const detector = rules ? new Detector(rules) : undefined;
	const redactor = new Redactor(detector);
	const repeats = new RepeatMemory();
	let known: KnownValue[] = [];
	let knownAt = 0;

	const active = () => settings.enabled && !envDisabled();
	const knownValues = (force = false) => {
		if (force || Date.now() - knownAt > KNOWN_TTL_MS) {
			known = collectKnownSecrets();
			knownAt = Date.now();
		}
		return known;
	};

	pi.on("session_start", () => {
		settings = readSettings();
		knownValues(true);
	});

	pi.on("tool_call", (event) => {
		if (!active()) return undefined;
		return handleToolCall(event as never, redactor, repeats);
	});

	pi.on("tool_result", (event) => {
		if (!active()) return undefined;
		return redactToolResult(event as never, redactor, { named: settings.named, known: knownValues() }) as never;
	});

	// ── /secret-redact ──────────────────────────────────────────────────────

	const statusLines = (): string[] => {
		const m = messages();
		const lines = [envDisabled() ? m.statusEnvOff : settings.enabled ? m.statusOn : m.statusOff];
		const hits = [...redactor.registry.hits.entries()].sort((a, b) => b[1] - a[1]);
		const total = hits.reduce((sum, [, n]) => sum + n, 0);
		lines.push(
			m.replaced(
				total,
				hits
					.slice(0, 4)
					.map(([kind, n]) => `${kind} ${n}`)
					.join(", "),
			),
		);
		if (rules) lines.push(m.rules(rules.rules.length, rules.skipped.length, rulesVersion()));
		else lines.push(m.rulesError(rulesError ?? "?"));
		const values = knownValues();
		const sources = [...new Set(values.map((item) => sourceOf(item.label)))];
		lines.push(m.known(values.length, sources.join(", ")));
		if (detector && detector.slow.size > 0) lines.push(m.slowRules([...detector.slow].join(", ")));
		return lines;
	};

	const items = (): MenuItem[] => {
		const m = messages();
		return [
			{ value: "enabled", label: m.itemEnabled, hint: settings.enabled ? m.on : m.off, hintTone: settings.enabled ? "success" : "dim", description: m.enabledHelp },
			{ value: "named", label: m.itemNamed, hint: settings.named ? m.on : m.off, hintTone: settings.named ? "success" : "dim", description: m.namedHelp },
			{ value: "reload", label: m.itemReload, description: m.reloadHelp },
		];
	};

	const apply = (choice: string): Notice | undefined => {
		const m = messages();
		if (choice === "enabled") {
			settings = { ...settings, enabled: !settings.enabled };
			writeSettings(settings);
			return { text: m.savedEnabled(settings.enabled), type: settings.enabled ? "success" : "warning" };
		}
		if (choice === "named") {
			settings = { ...settings, named: !settings.named };
			writeSettings(settings);
			return { text: m.savedNamed(settings.named), type: "info" };
		}
		if (choice === "reload") return { text: m.reloaded(knownValues(true).length), type: "success" };
		return undefined;
	};

	const runMenu = async (ctx: ExtensionCommandContext) => {
		let notice: Notice | undefined;
		let selected: string | undefined;
		for (;;) {
			const choice = await showMenu(ctx, () => ({
				title: messages().title,
				status: statusLines(),
				notice,
				items: items(),
				selected,
				cancelLabel: messages().close,
			}));
			if (!choice) return;
			selected = choice;
			notice = apply(choice);
		}
	};

	pi.registerCommand("secret-redact", {
		description: "secret-redact: status, on/off, values named like secrets (subcommands: status, on, off, named on|off)",
		getArgumentCompletions: (prefix) => {
			const matches = ["status", "on", "off", "named on", "named off"].filter((sub) => sub.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			settings = readSettings();
			const words = args.trim().split(/\s+/u).filter(Boolean);
			const [sub, value] = words;
			if (!sub) {
				if (ctx.hasUI) await runMenu(ctx);
				else ctx.ui.notify(statusLines().join("\n"), "info");
				return;
			}
			if (sub === "on" || sub === "off") {
				if (settings.enabled !== (sub === "on")) apply("enabled");
			} else if (sub === "named" && (value === "on" || value === "off")) {
				if (settings.named !== (value === "on")) apply("named");
			}
			ctx.ui.notify(statusLines().join("\n"), "info");
		},
	});
}
