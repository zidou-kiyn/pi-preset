/**
 * Ramp status bar — theme-reactive footer for pi.
 *
 * Design: a polychromatic constellation, with the hues spent on the segments
 * that are ALWAYS visible (traffic, cache, cost, context, model) — not on
 * branch/session, which are often absent. Icon and value wear the segment hue
 * together: in=mdLink, out=success, cacheRead=syntaxOperator,
 * cacheWrite=syntaxType, cost=warning, model=accent; the ramp meter walks the
 * thinking-level tokens positionally (≥1 cell always lit) so its tail is the
 * "hot" end. Every color is a semantic theme token — zero hardcoded hex — so
 * the active theme provides ALL coloration and the bar re-skins itself on
 * theme switch: soft pastels in pastel-aurora, neon electrics in synthwave-pi.
 *
 * Layout ideas referenced from reference/footers:
 * - smoosex/pi-footer            clean setFooter shape, segments, overflow
 * - wobondar/pi-footer           context bar widget, flex right-align
 * - nicobailon/pi-powerline-...  responsive width tiers
 *
 * Local addition (merged from the previous pi-native-footer): an optional aux
 * line carrying loaded-package count and todo progress, using the same nf-md-*
 * glyph family and semantic-token discipline as the rest of the bar. The line
 * stays hidden when there is nothing to report, preserving the "quiet when
 * empty" philosophy.
 *
 * Deliberately NOT shown: MCP server count. pi has no MCP support at all
 * (README: "**No MCP.** Build CLI tools with READMEs"), so such a segment can
 * only ever read zero. The slot carries the loaded package count instead.
 *
 * Runtime: pi-preset/extensions/vibrant-footer.ts
 * Toggle:  /vibrant-footer
 */

import { basename, isAbsolute, relative, resolve, sep as pathSep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── theme shim ──────────────────────────────────────────────────────────────

type ThemeLike = {
    fg(color: string, text: string): string;
    bold(text: string): string;
};

// ── icons (nerd when available, unicode otherwise) ──────────────────────────

type IconSet = {
    path: string;
    branch: string;
    session: string;
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
    cacheHit: string;
    cost: string;
    context: string;
    time: string;
    model: string;
    thinking: string;
    pkg: string;
    todo: string;
    todoActive: string;
};

/**
 * Nerd Fonts v3, Material Design plane (nf-md-*, U+F0000+) — deliberately a
 * different glyph family from ~/.claude/statusline-command.sh (which uses
 * FontAwesome/Octicons), so the pi bar has its own iconographic voice.
 * Codepoints verified against ryanoasis/nerd-fonts glyphnames.json.
 */
const NERD_ICONS: IconSet = {
    path: "\u{f018b}", // nf-md-compass
    branch: "\u{f062c}", // nf-md-source_branch
    session: "\u{f04f9}", // nf-md-tag
    input: "\u{f0da3}", // nf-md-transfer_up
    output: "\u{f0da1}", // nf-md-transfer_down
    cacheRead: "\u{f035b}", // nf-md-memory
    cacheWrite: "\u{f02fa}", // nf-md-import
    cacheHit: "\u{f04fe}", // nf-md-target
    cost: "\u{f01c8}", // nf-md-diamond_stone
    context: "\u{f029a}", // nf-md-gauge
    time: "\u{f051f}", // nf-md-timer_sand
    model: "\u{f0768}", // nf-md-atom
    thinking: "\u{f09d1}", // nf-md-brain
    pkg: "\u{f03d7}", // nf-md-package_variant_closed
    todo: "\u{f0756}", // nf-md-format_list_checks
    todoActive: "\u{f0995}", // nf-md-progress_check
};

const UNICODE_ICONS: IconSet = {
    path: "✧",
    branch: "⎇",
    session: "⌁",
    input: "↑",
    output: "↓",
    cacheRead: "▤",
    cacheWrite: "↻",
    cacheHit: "◎",
    cost: "◈",
    context: "▣",
    time: "◷",
    model: "π",
    thinking: "◆",
    pkg: "⬡",
    todo: "☑",
    todoActive: "▸",
};

function hasNerdFonts(): boolean {
    if (process.env.POWERLINE_NERD_FONTS === "0") return false;
    if (process.env.POWERLINE_NERD_FONTS === "1") return true;
    if (process.env.GHOSTTY_RESOURCES_DIR) return true;
    const term = (process.env.TERM_PROGRAM || process.env.TERM || "").toLowerCase();
    const knownBad = ["linux", "dumb"];
    if (knownBad.some((t) => term === t)) return false;
    return true;
}

function getIcons(): IconSet {
    return hasNerdFonts() ? NERD_ICONS : UNICODE_ICONS;
}

// ── small helpers ───────────────────────────────────────────────────────────

type UsageTotals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    cacheHitRate: number | undefined;
};

type TodoTask = {
    status?: string;
    subject?: string;
    activeForm?: string;
};

const DOT = "·";

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m${seconds % 60}s`;
    return `${seconds}s`;
}

function formatCwd(cwd: string, home: string | undefined, mode: "full" | "abbrev" | "base" = "full"): string {
    if (mode === "base") return basename(cwd) || cwd;

    let display = cwd;
    if (home) {
        const resolvedCwd = resolve(cwd);
        const resolvedHome = resolve(home);
        const relativeToHome = relative(resolvedHome, resolvedCwd);
        const isInsideHome =
            relativeToHome === "" ||
            (relativeToHome !== ".." &&
                !relativeToHome.startsWith(`..${pathSep}`) &&
                !isAbsolute(relativeToHome));
        if (isInsideHome) {
            display = relativeToHome === "" ? "~" : `~${pathSep}${relativeToHome}`;
        }
    }

    if (mode === "abbrev" && display.length > 42) {
        return `…${display.slice(-41)}`;
    }
    return display;
}

function sanitizeStatusText(text: string): string {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function join(parts: Array<string | false | null | undefined>, separator: string): string {
    return parts.filter((p): p is string => Boolean(p)).join(separator);
}

function softSep(t: ThemeLike): string {
    return t.fg("dim", ` ${DOT} `);
}

function padBetween(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
}

/**
 * Colored segment: glyph carries the segment's identity hue (a semantic theme
 * token, so each theme re-skins the whole constellation), value rides in the
 * soft text tone unless it carries meaning of its own.
 */
function seg(t: ThemeLike, glyph: string, glyphColor: string, value: string, valueColor = "thinkingText"): string {
    const g = glyph ? t.fg(glyphColor, glyph) + " " : "";
    return g + t.fg(valueColor, value);
}

function contextTone(percent: number | null): "success" | "warning" | "error" {
    if (percent === null) return "success";
    if (percent > 90) return "error";
    if (percent > 70) return "warning";
    return "success";
}

function cacheTone(rate: number): "success" | "warning" | "error" {
    if (rate >= 50) return "success";
    if (rate >= 25) return "warning";
    return "error";
}

function thinkingStyle(level: string): { color: string; label: string } {
    switch (level) {
        case "max":
            return { color: "thinkingMax", label: "max" };
        case "xhigh":
            return { color: "thinkingXhigh", label: "xhigh" };
        case "high":
            return { color: "thinkingHigh", label: "high" };
        case "medium":
            return { color: "thinkingMedium", label: "med" };
        case "low":
            return { color: "thinkingLow", label: "low" };
        case "minimal":
            return { color: "thinkingMinimal", label: "min" };
        default:
            return { color: "thinkingOff", label: "off" };
    }
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let cacheHitRate: number | undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            const m = entry.message as AssistantMessage;
            input += m.usage.input;
            output += m.usage.output;
            cacheRead += m.usage.cacheRead;
            cacheWrite += m.usage.cacheWrite;
            cost += m.usage.cost.total;

            const prompt = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
            cacheHitRate = prompt > 0 ? (m.usage.cacheRead / prompt) * 100 : undefined;
        }
    }

    return { input, output, cacheRead, cacheWrite, cost, cacheHitRate };
}

/**
 * Distinct installed packages currently contributing to the session.
 *
 * Tools and slash commands both carry a `sourceInfo`, and package-provided ones
 * are tagged `origin: "package"` — so unioning the two surfaces gives a count
 * that covers packages shipping tools, commands, or both. Packages that only
 * install a footer or an event hook stay invisible here; there is no public API
 * enumerating loaded extensions.
 */
function packageCount(pi: ExtensionAPI): number {
    const sources = new Set<string>();
    const add = (info: { source?: string; path?: string; origin?: string } | undefined) => {
        if (!info || info.origin !== "package") return;
        const key = info.source || info.path;
        if (key) sources.add(key);
    };
    try {
        for (const tool of pi.getAllTools()) add(tool.sourceInfo);
        for (const command of pi.getCommands()) add(command.sourceInfo);
    } catch {
        return sources.size;
    }
    return sources.size;
}

/** Latest todo snapshot on the active branch (rpiv-todo writes details.tasks). */
function latestTodos(ctx: ExtensionContext): TodoTask[] {
    let tasks: TodoTask[] = [];
    try {
        for (const raw of ctx.sessionManager.getBranch()) {
            const entry = raw as {
                type?: string;
                message?: { role?: string; toolName?: string; details?: { tasks?: unknown } };
            };
            const message = entry.message;
            if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "todo") continue;
            if (Array.isArray(message.details?.tasks)) tasks = message.details.tasks as TodoTask[];
        }
    } catch {
        return [];
    }
    return tasks.filter((task) => task.status !== "deleted");
}

// ── the signature: ramp meter ───────────────────────────────────────────────

/**
 * Context-usage meter whose cells walk the theme's thinking ramp by POSITION,
 * not by fill level: the left cells are always the calm end of the ramp and
 * the right cells the hot end. Filling context usage therefore moves you
 * toward the hot zone — the meter encodes "approaching the limit" in color
 * before the percent number says so.
 */
const RAMP: readonly string[] = ["thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh"];

function rampMeter(t: ThemeLike, percent: number | null, cells: number): string {
    let out = "";
    // Always light at least one cell for a live session, so the meter shows
    // color even at low usage instead of reading as an empty gray strip.
    const filled =
        percent === null ? 0 : Math.max(percent > 0 ? 1 : 0, Math.min(cells, Math.round((percent / 100) * cells)));
    for (let i = 0; i < cells; i++) {
        if (i < filled) {
            const token = RAMP[Math.min(RAMP.length - 1, Math.floor((i / cells) * RAMP.length))]!;
            out += t.fg(token, "▰");
        } else {
            out += t.fg("dim", "▱");
        }
    }
    return out;
}

// ── layout: overflow later segments onto a second stats line ────────────────

function layoutSegments(segments: string[], separator: string, width: number): string[] {
    if (segments.length === 0) return [];

    const sepW = visibleWidth(separator);
    const lines: string[][] = [[]];
    let lineWidth = 0;

    for (const segment of segments) {
        const w = visibleWidth(segment);
        const current = lines[lines.length - 1]!;
        const needed = w + (current.length > 0 ? sepW : 0);

        if (current.length > 0 && lineWidth + needed > width && lines.length < 2) {
            lines.push([segment]);
            lineWidth = w;
            continue;
        }

        current.push(segment);
        lineWidth += needed;
    }

    return lines
        .filter((parts) => parts.length > 0)
        .map((parts) => truncateToWidth(parts.join(separator), width, "…"));
}

// ── render lines ────────────────────────────────────────────────────────────

function renderPathLine(
    t: ThemeLike,
    ctx: ExtensionContext,
    branch: string | null,
    icons: IconSet,
    width: number,
): string {
    const pathMode = width < 60 ? "base" : width < 100 ? "abbrev" : "full";
    const path = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE, pathMode);
    const sessionName = ctx.sessionManager.getSessionName();

    const line = join(
        [
            seg(t, icons.path, "mdLink", path, "text"),
            branch ? seg(t, icons.branch, "mdQuote", branch, "thinkingText") : null,
            sessionName ? seg(t, icons.session, "customMessageLabel", sessionName, "thinkingText") : null,
        ],
        softSep(t),
    );

    return truncateToWidth(line, width, t.fg("dim", "…"));
}

function renderStatsLines(
    t: ThemeLike,
    ctx: ExtensionContext,
    usage: UsageTotals,
    getThinking: () => string,
    icons: IconSet,
    sessionStartMs: number,
    width: number,
): string[] {
    const context = ctx.getContextUsage();
    const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percentValue = context?.percent ?? null;
    const tone = contextTone(percentValue);
    const sep = softSep(t);

    const segments: string[] = [];

    // Context first — the ramp meter is the anchor of the line.
    const meterCells = width >= 100 ? 6 : width >= 72 ? 5 : 0;
    const percentLabel = percentValue !== null ? `${percentValue.toFixed(1)}%` : "?";
    const windowLabel = t.fg("dim", `/${formatTokens(contextWindow)}`);
    const contextText = t.fg(tone, percentLabel) + windowLabel;
    if (meterCells > 0) {
        segments.push(`${rampMeter(t, percentValue, meterCells)} ${contextText}`);
    } else {
        segments.push(seg(t, icons.context, tone, "") + contextText);
    }

    // Traffic: ↑in ↓out — icon AND value wear the segment hue; a single colored
    // glyph next to gray digits doesn't register at terminal sizes.
    if (usage.input || usage.output) {
        const parts: string[] = [];
        if (usage.input) parts.push(seg(t, icons.input, "mdLink", formatTokens(usage.input), "mdLink"));
        if (usage.output) parts.push(seg(t, icons.output, "success", formatTokens(usage.output), "success"));
        segments.push(parts.join(" "));
    }

    // Cache: read, write, hit rate (hit tone shifts as it degrades)
    if (usage.cacheRead || usage.cacheWrite) {
        const parts: string[] = [];
        if (usage.cacheRead)
            parts.push(seg(t, icons.cacheRead, "syntaxOperator", formatTokens(usage.cacheRead), "syntaxOperator"));
        if (usage.cacheWrite)
            parts.push(seg(t, icons.cacheWrite, "syntaxType", formatTokens(usage.cacheWrite), "syntaxType"));
        if (usage.cacheHitRate !== undefined) {
            const hit = usage.cacheHitRate;
            const hitTone = cacheTone(hit);
            parts.push(seg(t, icons.cacheHit, hitTone, `${hit.toFixed(0)}%`, hitTone));
        }
        segments.push(parts.join(" "));
    }

    // Cost — or, when the provider reports no price (proxies and most OAuth
    // subscriptions send cost.total = 0), the cumulative token volume, so the
    // slot always carries a real number instead of silently vanishing.
    if (usage.cost > 0) {
        let usingOAuth = false;
        try {
            usingOAuth = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
        } catch {
            usingOAuth = false;
        }
        const amount = usingOAuth ? `${usage.cost.toFixed(3)} sub` : usage.cost.toFixed(3);
        segments.push(seg(t, icons.cost, "warning", amount, "warning"));
    } else {
        const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (totalTokens > 0) {
            segments.push(seg(t, icons.cost, "warning", formatTokens(totalTokens), "warning"));
        }
    }

    // Session elapsed (only after ≥5s so empty sessions stay quiet)
    const elapsed = Date.now() - sessionStartMs;
    if (elapsed >= 5000) {
        segments.push(seg(t, icons.time, "dim", formatDuration(elapsed), "dim"));
    }

    // Right cluster: provider · model · thinking — model is the line's one accent.
    const modelId = ctx.model?.id ?? "no-model";
    const provider = ctx.model?.provider;
    const supportsReasoning = Boolean(ctx.model?.reasoning);

    let thinkingPart: string | null = null;
    if (supportsReasoning) {
        const style = thinkingStyle(getThinking());
        thinkingPart = t.fg(style.color, `${icons.thinking} ${style.label}`);
    }

    const right = join(
        [provider ? t.fg("muted", provider) : null, t.bold(t.fg("accent", `${icons.model} ${modelId}`)), thinkingPart],
        sep,
    );

    const rightW = visibleWidth(right);
    const leftBudget = rightW > 0 ? Math.max(20, width - rightW - 2) : width;

    const leftLines = layoutSegments(segments, sep, leftBudget);
    if (leftLines.length === 0) {
        return [truncateToWidth(right, width, t.fg("dim", "…"))];
    }

    const firstLeft = leftLines[0]!;
    let first: string;
    if (rightW === 0) {
        first = firstLeft;
    } else if (visibleWidth(firstLeft) + 2 + rightW <= width) {
        first = padBetween(firstLeft, right, width);
    } else {
        const available = Math.max(0, width - visibleWidth(firstLeft) - 1);
        first = firstLeft + " " + truncateToWidth(right, available, t.fg("dim", "…"));
    }

    const lines = [first];
    for (let i = 1; i < leftLines.length; i++) {
        lines.push(leftLines[i]!);
    }
    return lines;
}

/**
 * Aux line: loaded packages + todo progress. Returns null when there is nothing
 * to say, so a plain session keeps the bar at two lines.
 */
function renderAuxLine(
    t: ThemeLike,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    icons: IconSet,
    width: number,
): string | null {
    const parts: string[] = [];

    const packages = packageCount(pi);
    if (packages > 0) {
        parts.push(seg(t, icons.pkg, "syntaxKeyword", `pkg ${packages}`, "syntaxKeyword"));
    }

    const tasks = latestTodos(ctx);
    if (tasks.length > 0) {
        const done = tasks.filter((task) => task.status === "completed").length;
        const allDone = done === tasks.length;
        const tone = allDone ? "success" : "mdHeading";
        parts.push(seg(t, icons.todo, tone, `${done}/${tasks.length}`, tone));

        const current = tasks.find((task) => task.status === "in_progress");
        if (current) {
            const label = sanitizeStatusText(current.activeForm || current.subject || "working");
            if (label) parts.push(seg(t, icons.todoActive, "mdHeading", label, "text"));
        }
    }

    if (parts.length === 0) return null;
    return truncateToWidth(parts.join(softSep(t)), width, t.fg("dim", "…"));
}

// ── extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let enabled = true;
    let sessionStartMs = Date.now();
    let requestRender: (() => void) | undefined;

    const applyFooter = (ctx: ExtensionContext) => {
        if (ctx.mode !== "tui") return;

        if (!enabled) {
            ctx.ui.setFooter(undefined);
            return;
        }

        ctx.ui.setFooter((tui, theme, footerData) => {
            requestRender = () => tui.requestRender();
            const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
            const t = theme as ThemeLike;
            const icons = getIcons();

            // Gentle tick so the session timer updates without busy-looping
            const timer = setInterval(() => tui.requestRender(), 30_000);
            timer.unref?.();

            return {
                dispose() {
                    unsubBranch();
                    clearInterval(timer);
                    requestRender = undefined;
                },
                invalidate() {},
                render(width: number): string[] {
                    const usage = collectUsage(ctx);
                    const branch = footerData.getGitBranch();

                    const lines = [
                        renderPathLine(t, ctx, branch, icons, width),
                        ...renderStatsLines(
                            t,
                            ctx,
                            usage,
                            () => pi.getThinkingLevel(),
                            icons,
                            sessionStartMs,
                            width,
                        ),
                    ];

                    const aux = renderAuxLine(t, pi, ctx, icons, width);
                    if (aux) lines.push(aux);

                    const extensionStatuses = footerData.getExtensionStatuses();
                    if (extensionStatuses.size > 0) {
                        const sorted = Array.from(extensionStatuses.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([, text]) => sanitizeStatusText(text))
                            .filter(Boolean);
                        if (sorted.length > 0) {
                            lines.push(truncateToWidth(sorted.join(softSep(t)), width, t.fg("dim", "…")));
                        }
                    }

                    return lines;
                },
            };
        });
    };

    pi.on("session_start", async (_event, ctx) => {
        sessionStartMs = Date.now();
        applyFooter(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
        if (enabled) applyFooter(ctx);
    });

    pi.on("thinking_level_select", async (_event, ctx) => {
        if (enabled) applyFooter(ctx);
    });

    // Keep usage/todo/MCP numbers live without a fast polling timer.
    // Registered one-by-one: pi.on() is an overload set, so a union event name
    // from a loop variable fails to resolve.
    pi.on("turn_end", async () => {
        requestRender?.();
    });
    pi.on("message_end", async () => {
        requestRender?.();
    });
    pi.on("tool_execution_end", async () => {
        requestRender?.();
    });

    pi.registerCommand("vibrant-footer", {
        description: "Toggle the ramp status bar",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            applyFooter(ctx);
            ctx.ui.notify(enabled ? "Ramp status bar on" : "Default footer restored", "info");
        },
    });
}
