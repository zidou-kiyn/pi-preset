/**
 * The approval gate for the Termius MCP tools, and what pi adds to their results.
 *
 * tool_call (exec / files): resolve the host the agent named (id or label) to
 * its cloud id, take its effective level (temporary > host > global, plus a
 * session allow), classify the call (read / write, catastrophic), and run,
 * refuse, or ask. Questions are asked one at a time; a call waiting behind
 * another dialog is re-checked when its turn comes, so allowing a host for
 * the session answers the calls queued for it too.
 *
 * tool_result: `hosts` / `host` rows get the effective level (`access`,
 * `access_source`, `session_allowed`); exec / files calls are written to the
 * activity log with their route and exit code.
 *
 * Text for the model (block reasons, the access fields) is English; the
 * dialog uses the UI language.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MenuItem, showMenu } from "../preset-menu.ts";
import type { ActivityEntry } from "./activity.ts";
import { catastrophicRule, describeCall, GATED_TERMIUS_TOOLS, writeReason } from "./approval.ts";
import type { TermiusConfig } from "./config.ts";
import { routeStages, routeSummary } from "./format.ts";
import type { HostIndex, HostRow } from "./host-index.ts";
import { decide, type EffectiveLevel, effectiveLevel, type Level, stricter } from "./levels.ts";
import { type ActivityDecision, messages } from "./messages.ts";
import type { SessionGrants } from "./session-state.ts";

export const TOOL_PREFIX = "mcp__termius__";

export interface GateDeps {
	config(): TermiusConfig;
	grants: SessionGrants;
	hosts: HostIndex;
	/** Save a host's level (from "Always trust" / "Deny and disable"). */
	saveHostLevel(key: string, level: Level, label: string): void;
	/** Session grants changed: persist them and refresh the footer. */
	grantsChanged(): void;
	record(entry: ActivityEntry): void;
	/** Labels of the hosts calls are running on, for the footer. */
	activeChanged(labels: string[]): void;
}

interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

interface ToolResultEvent extends ToolCallEvent {
	content: { type: string; text?: string }[];
	structuredContent?: unknown;
	isError: boolean;
}

interface Target {
	/** Cloud id, or `name:<name>` when the name matched no single host. */
	key: string;
	label: string;
	row?: HostRow;
	rows: HostRow[];
}

interface Pending {
	entry: Omit<ActivityEntry, "route" | "exit" | "error">;
	label: string;
}

type Block = { block: true; reason: string };

function refusalReason(because: "off" | "read-only", label: string, catastrophic: boolean): string {
	if (because === "off") {
		return `${label} is disabled by the user in /termius. Do not reach it another way; ask the user to enable it there if it is needed.`;
	}
	return `${label} is read-only (the user's setting in /termius): this ${catastrophic ? "catastrophic command" : "call would change the host and"} is refused. Do not retry it or work around it; tell the user what you need. They can give the host a temporary level in /termius → Hosts.`;
}

function detailOf(tool: string, args: Record<string, unknown>): string {
	if (tool === "exec") return String(args.command ?? "");
	const path = args.path === undefined ? "" : ` ${String(args.path)}`;
	const dest = args.dest === undefined ? "" : ` -> ${String(args.dest)}`;
	return `${String(args.action ?? "?")}${path}${dest}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TermiusGate {
	private readonly deps: GateDeps;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly pending = new Map<string, Pending>();

	constructor(deps: GateDeps) {
		this.deps = deps;
	}

	private async target(name: string): Promise<Target> {
		let rows = this.deps.hosts.resolve(name);
		if (rows.length === 0 && name) {
			// A host added since the list was loaded, or the list was never loaded.
			await this.deps.hosts.refresh(false);
			rows = this.deps.hosts.resolve(name);
		}
		if (rows.length === 1) return { key: rows[0]!.cloud_id, label: rows[0]!.label, row: rows[0], rows };
		return { key: `name:${name}`, label: name || "?", rows };
	}

	/** The effective level for a key. */
	levelOf(key: string): EffectiveLevel {
		const config = this.deps.config();
		const grants = this.deps.grants;
		return effectiveLevel({
			globalLevel: config.mode,
			hostLevel: config.hosts?.[key]?.level,
			temporaryLevel: grants.temporaryLevel(key),
			sessionAllowed: grants.isAllowed(key),
		});
	}

	private levelFor(target: Target): EffectiveLevel {
		// Several hosts share the label: the server will refuse the name, but be strict meanwhile.
		if (target.rows.length > 1) return target.rows.map((row) => this.levelOf(row.cloud_id)).reduce(stricter);
		return this.levelOf(target.key);
	}

	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private start(event: ToolCallEvent, tool: string, args: Record<string, unknown>, target: Target, decision: ActivityDecision): void {
		this.pending.set(event.toolCallId, {
			label: target.label,
			entry: {
				time: new Date().toISOString(),
				host: target.label,
				...(target.row ? { key: target.key } : {}),
				tool: tool as "exec" | "files",
				detail: detailOf(tool, args),
				decision,
			},
		});
		this.deps.activeChanged([...this.pending.values()].map((item) => item.label));
	}

	private blocked(tool: string, args: Record<string, unknown>, target: Target, decision: ActivityDecision, reason: string): Block {
		this.deps.record({
			time: new Date().toISOString(),
			host: target.label,
			...(target.row ? { key: target.key } : {}),
			tool: tool as "exec" | "files",
			detail: detailOf(tool, args),
			...(target.row ? { route: routeSummary(target.row.route) } : {}),
			decision,
		});
		return { block: true, reason };
	}

	async onToolCall(event: ToolCallEvent, ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">): Promise<Block | undefined> {
		if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
		const tool = event.toolName.slice(TOOL_PREFIX.length);
		if (!GATED_TERMIUS_TOOLS.has(tool)) return undefined;
		const args = isObject(event.input) ? event.input : {};
		const target = await this.target(String(args.name ?? ""));
		const reason = writeReason(tool, args);
		const rule = catastrophicRule(tool, args);
		const kind = reason ? "write" : "read";

		const evaluate = () => decide(this.levelFor(target), kind, rule !== undefined);
		/** Who let a call run: the level itself, or a session allow over a level that would ask. */
		const runBy = (): ActivityDecision => {
			const effective = this.levelFor(target);
			return effective.sessionAllowed && decide({ ...effective, sessionAllowed: false }, kind, rule !== undefined).action === "ask" ? "session" : "auto";
		};
		let decision = evaluate();
		if (decision.action === "run") {
			this.start(event, tool, args, target, runBy());
			return undefined;
		}
		if (decision.action === "refuse") {
			return this.blocked(tool, args, target, "refused", refusalReason(decision.because, target.label, rule !== undefined));
		}
		if (!ctx.hasUI) {
			const effective = this.levelFor(target);
			return this.blocked(
				tool,
				args,
				target,
				"no-ui",
				`termius: this call on ${target.label} (level ${effective.level}${rule ? ", catastrophic command" : ""}) needs the user's approval, and this session has no UI to ask in.`,
			);
		}

		return this.serial(async () => {
			// An earlier dialog may have settled it (session allow, trust, disable).
			decision = evaluate();
			if (decision.action === "run") {
				const by = runBy();
				this.start(event, tool, args, target, by === "auto" ? "approved" : by);
				return undefined;
			}
			if (decision.action === "refuse") {
				return this.blocked(tool, args, target, "refused", refusalReason(decision.because, target.label, rule !== undefined));
			}
			return this.ask(event, ctx, tool, args, target, reason === undefined ? undefined : messages().writeReason(reason), rule);
		});
	}

	private async ask(
		event: ToolCallEvent,
		ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
		tool: string,
		args: Record<string, unknown>,
		target: Target,
		why: string | undefined,
		rule: ReturnType<typeof catastrophicRule>,
	): Promise<Block | undefined> {
		const m = messages();
		const effective = this.levelFor(target);
		const level = m.levelName(effective.level);
		const known = target.row !== undefined;
		const route = target.row ? routeSummary(target.row.route, m) : m.unknownHost;
		const items: MenuItem[] = [{ value: "once", label: m.allowOnce }];
		if (!rule) {
			items.push({ value: "session", label: m.allowSession(target.label), description: m.allowSessionHelp });
			if (known) items.push({ value: "trust", label: m.trustAlways(target.label), description: m.trustAlwaysHelp });
		}
		items.push({ value: "deny", label: m.deny });
		if (known) items.push({ value: "disable", label: m.denyDisable(target.label), description: m.denyDisableHelp });
		items.push({ value: "reason", label: m.denyReason });

		const status = [
			describeCall(tool, args),
			m.askWhere(target.row?.address ?? "?", route, level, m.levelSource(effective.source)),
			m.askWhy(why ?? m.askReviewReason),
		];
		const choice = await showMenu(ctx, () => ({
			title: rule ? m.askCatastrophicTitle(target.label) : m.askTitle(level, target.label),
			status,
			notice: rule ? { text: m.askCatastrophic(m.catastrophicRule(rule)), type: "error" } : undefined,
			items,
			cancelLabel: m.deny.toLowerCase(),
		}));

		switch (choice) {
			case "once":
				this.start(event, tool, args, target, "approved");
				return undefined;
			case "session":
				this.deps.grants.allow(target.key);
				this.deps.grantsChanged();
				this.start(event, tool, args, target, "session");
				return undefined;
			case "trust":
				this.deps.saveHostLevel(target.key, "trusted", target.label);
				this.start(event, tool, args, target, "approved");
				return undefined;
			case "disable":
				this.deps.saveHostLevel(target.key, "off", target.label);
				return this.blocked(
					tool,
					args,
					target,
					"denied",
					`The user denied this command and disabled ${target.label} in /termius. Do not use it again; ask the user how to proceed.`,
				);
			case "reason": {
				const text = (await ctx.ui.input(m.denyReasonTitle, m.denyReasonHint))?.trim();
				if (text) {
					return this.blocked(tool, args, target, "denied", `The user denied this remote command and said: "${text}". Follow that instead of retrying the same command.`);
				}
				break;
			}
		}
		return this.blocked(tool, args, target, "denied", "The user denied this remote command. Ask how to proceed instead of retrying.");
	}

	/** Access fields for one host row (for the model). */
	private access(key: string): Record<string, unknown> {
		const effective = this.levelOf(key);
		return {
			access: effective.level,
			access_source: effective.source,
			...(effective.sessionAllowed ? { session_allowed: true } : {}),
		};
	}

	onToolResult(event: ToolResultEvent): { content?: ToolResultEvent["content"]; structuredContent?: unknown } | undefined {
		if (!event.toolName.startsWith(TOOL_PREFIX)) return undefined;
		const tool = event.toolName.slice(TOOL_PREFIX.length);
		if (GATED_TERMIUS_TOOLS.has(tool)) {
			this.finish(event, tool);
			return undefined;
		}
		if ((tool !== "hosts" && tool !== "host") || event.isError || !isObject(event.structuredContent)) return undefined;
		const data = event.structuredContent;
		let annotated: Record<string, unknown>;
		if (tool === "hosts" && Array.isArray(data.hosts)) {
			annotated = {
				...data,
				hosts: data.hosts.map((row) => (isObject(row) && typeof row.cloud_id === "string" ? { ...row, ...this.access(row.cloud_id) } : row)),
			};
		} else if (tool === "host" && typeof data.cloud_id === "string") {
			annotated = { ...data, ...this.access(data.cloud_id) };
		} else {
			return undefined;
		}
		const json = JSON.stringify(annotated);
		const content = event.content.map((item) => {
			if (item.type !== "text" || !item.text?.startsWith("{")) return item;
			try {
				return isObject(JSON.parse(item.text)) ? { ...item, text: json } : item;
			} catch {
				return item;
			}
		});
		return { content, structuredContent: annotated };
	}

	private finish(event: ToolResultEvent, tool: string): void {
		const pending = this.pending.get(event.toolCallId);
		if (!pending) return;
		this.pending.delete(event.toolCallId);
		this.deps.activeChanged([...this.pending.values()].map((item) => item.label));
		const data = isObject(event.structuredContent) ? event.structuredContent : {};
		const entry: ActivityEntry = { ...pending.entry };
		// The server echoes the command with vault secrets redacted; prefer it.
		if (tool === "exec" && typeof data.command === "string") entry.detail = data.command;
		const route = routeStages(data.route);
		if (route) entry.route = route;
		if (tool === "exec" && !event.isError) entry.exit = typeof data.exit_code === "number" ? data.exit_code : null;
		if (event.isError) entry.error = typeof data.code === "string" ? data.code : "error";
		this.deps.record(entry);
	}

	/** A call that never produced a result (cancelled before it ran). */
	forget(toolCallId: string): void {
		if (this.pending.delete(toolCallId)) this.deps.activeChanged([...this.pending.values()].map((item) => item.label));
	}
}
