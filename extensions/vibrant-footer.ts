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
 * MCP (pi 0.99+ ships it built in): the aux line shows connected servers and
 * their tools as `mcp 2·14`, derived from the `mcp__<server>__<tool>` tools
 * the built-in extension registers, or a dim `mcp 0` while none is connected.
 * Extensions cannot read connection state, so failed or signed-out servers are
 * not counted; pi reports those itself after startup and in /mcp. Small
 * `cm` / `ts` tags mark the built-in `codemode` / `tool_search` tools while
 * they are active. The segment is hidden only when MCP support is disabled.
 *
 * Stats line legend (labels drop only when two lines cannot hold them):
 *   meter 58k/272k 21%   current context: used / window, percent
 *   in / out             session-cumulative input and output tokens
 *   cache r / w / hit    session-cumulative cache read and cache write tokens,
 *                        and the latest turn's cache hit rate
 *   $ / Σ                session cost, or total tokens when no price is known
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
    mcp: string;
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
    mcp: "\u{f06a5}", // nf-md-power_plug
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
    mcp: "⧉",
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

/** Like seg(), with a dim word label between glyph and value when `showLabel` is set. */
function lseg(t: ThemeLike, glyph: string, color: string, label: string, value: string, showLabel: boolean): string {
    const g = glyph ? t.fg(color, glyph) + " " : "";
    const l = showLabel ? t.fg("dim", `${label} `) : "";
    return g + l + t.fg(color, value);
}

function formatPercent(percent: number): string {
    return percent < 10 ? `${percent.toFixed(1)}%` : `${percent.toFixed(0)}%`;
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

type McpSummary = { available: boolean; servers: number; tools: number; codemode: boolean; toolSearch: boolean };

const MCP_PREFIX = "mcp__";

/**
 * Connected MCP servers and their callable tools, plus whether the built-in
 * codemode / tool_search tools are active. MCP tools are named
 * `mcp__<server>__<tool>` and grouped under the `mcp__<server>` namespace; the
 * namespace is preferred because server names may themselves contain `_`.
 * Hidden tools are registered but uncallable, so they are not counted.
 */
function mcpSummary(pi: ExtensionAPI): McpSummary {
    const servers = new Set<string>();
    let tools = 0;
    let active: string[] = [];
    let available = false;
    try {
        // The built-in (or a replacing) MCP extension owns /mcp; without it MCP is off.
        available = pi.getCommands().some((command) => command.name === "mcp");
        for (const tool of pi.getAllTools()) {
            if (!tool.name.startsWith(MCP_PREFIX) || tool.exposure === "hidden") continue;
            const namespace = tool.namespace?.name;
            const server = namespace?.startsWith(MCP_PREFIX)
                ? namespace.slice(MCP_PREFIX.length)
                : tool.name.slice(MCP_PREFIX.length).split("__")[0];
            if (server) servers.add(server);
            tools++;
        }
        active = pi.getActiveTools();
    } catch {
        // Tool registry unavailable (e.g. mid-reload): report nothing.
    }
    return {
        available,
        servers: servers.size,
        tools,
        codemode: active.includes("codemode"),
        toolSearch: active.includes("tool_search"),
    };
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

type Layout = { lines: string[]; fits: boolean };

/**
 * Greedy two-line layout. The first line shares the row with the right
 * cluster (`firstWidth`); the overflow line has the full terminal width
 * (`restWidth`). `fits` is false when anything had to be truncated.
 */
function layoutSegments(segments: string[], separator: string, firstWidth: number, restWidth: number): Layout {
    if (segments.length === 0) return { lines: [], fits: true };

    const sepW = visibleWidth(separator);
    const lines: string[][] = [[]];
    const widths = [0];

    for (const segment of segments) {
        const w = visibleWidth(segment);
        const index = lines.length - 1;
        const current = lines[index]!;
        const limit = index === 0 ? firstWidth : restWidth;
        const needed = w + (current.length > 0 ? sepW : 0);

        if (current.length > 0 && widths[index]! + needed > limit && lines.length < 2) {
            lines.push([segment]);
            widths.push(w);
            continue;
        }

        current.push(segment);
        widths[index] = widths[index]! + needed;
    }

    const fits = widths.every((w, i) => w <= (i === 0 ? firstWidth : restWidth));
    return {
        fits,
        lines: lines
            .filter((parts) => parts.length > 0)
            .map((parts, i) => truncateToWidth(parts.join(separator), i === 0 ? firstWidth : restWidth, "…")),
    };
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
    const usedTokens = context?.tokens ?? null;
    const tone = contextTone(percentValue);
    const sep = softSep(t);

    // Built twice: with word labels (in/out/cache r/w/hit) and without. The
    // labeled variant wins whenever it fits in two lines; icons always stay.
    const buildSegments = (labels: boolean): string[] => {
        const segments: string[] = [];

        // Context first — the ramp meter is the anchor of the line, followed by the
        // absolute count ("58k/272k") so the meter never has to be read on its own.
        const meterCells = width >= 100 ? 6 : width >= 72 ? 5 : 0;
        const usedLabel = usedTokens !== null ? formatTokens(usedTokens) : "?";
        const windowLabel = t.fg("dim", `/${formatTokens(contextWindow)}`);
        const percentLabel = percentValue !== null ? " " + t.fg(tone, formatPercent(percentValue)) : "";
        const contextText = t.fg(tone, usedLabel) + windowLabel + percentLabel;
        if (meterCells > 0) {
            segments.push(`${rampMeter(t, percentValue, meterCells)} ${contextText}`);
        } else {
            segments.push(seg(t, icons.context, tone, "") + contextText);
        }

        // Traffic: session-cumulative in/out — icon AND value wear the segment hue;
        // a single colored glyph next to gray digits doesn't register at terminal sizes.
        if (usage.input || usage.output) {
            const parts: string[] = [];
            if (usage.input) parts.push(lseg(t, icons.input, "mdLink", "in", formatTokens(usage.input), labels));
            if (usage.output) parts.push(lseg(t, icons.output, "success", "out", formatTokens(usage.output), labels));
            segments.push(parts.join(" "));
        }

        // Cache: read, write, hit rate (hit tone shifts as it degrades)
        if (usage.cacheRead || usage.cacheWrite) {
            const parts: string[] = [];
            if (usage.cacheRead)
                parts.push(lseg(t, icons.cacheRead, "syntaxOperator", "cache r", formatTokens(usage.cacheRead), labels));
            if (usage.cacheWrite) {
                const label = usage.cacheRead ? "w" : "cache w";
                parts.push(lseg(t, icons.cacheWrite, "syntaxType", label, formatTokens(usage.cacheWrite), labels));
            }
            if (usage.cacheHitRate !== undefined) {
                const hit = usage.cacheHitRate;
                parts.push(lseg(t, icons.cacheHit, cacheTone(hit), "hit", `${hit.toFixed(0)}%`, labels));
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
            const amount = usingOAuth ? `$${usage.cost.toFixed(3)} sub` : `$${usage.cost.toFixed(3)}`;
            segments.push(seg(t, icons.cost, "warning", amount, "warning"));
        } else {
            // Σ marks a token total, so it is never mistaken for a price.
            const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
            if (totalTokens > 0) {
                segments.push(seg(t, icons.cost, "warning", `Σ${formatTokens(totalTokens)}`, "warning"));
            }
        }

        // Session elapsed (only after ≥5s so empty sessions stay quiet)
        const elapsed = Date.now() - sessionStartMs;
        if (elapsed >= 5000) {
            segments.push(seg(t, icons.time, "dim", formatDuration(elapsed), "dim"));
        }
        return segments;
    };

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

    const labeled = layoutSegments(buildSegments(true), sep, leftBudget, width);
    const leftLines = labeled.fits ? labeled.lines : layoutSegments(buildSegments(false), sep, leftBudget, width).lines;
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
 * Aux line: loaded packages, MCP, and todo progress. Returns null when there is nothing
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

    // MCP: always shown while MCP support is loaded. "mcp 0" (dim) means no
    // server is connected; "mcp 2·14" is servers·tools. Dim cm/ts tags mark
    // codemode / tool_search while active.
    const mcp = mcpSummary(pi);
    if (mcp.available || mcp.servers > 0 || mcp.codemode || mcp.toolSearch) {
        const tone = mcp.servers > 0 ? "syntaxFunction" : "dim";
        const count = mcp.servers > 0 ? `mcp ${mcp.servers}${DOT}${mcp.tools}` : "mcp 0";
        const tags = join([mcp.codemode ? "cm" : null, mcp.toolSearch ? "ts" : null], " ");
        parts.push(t.fg(tone, `${icons.mcp} ${count}`) + (tags ? t.fg("dim", ` ${tags}`) : ""));
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
