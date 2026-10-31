/**
 * Ramp status bar — theme-reactive footer for pi.
 *
 * Lines are grouped by meaning:
 *   1. where and who   path · branch · session          provider · model · thinking
 *   2. how much        context meter · ↑in ↓out · cache hit · ttl/warm · ssh ·
 *                      skills · cost · elapsed (overflows to one more line)
 *   3. what is loaded  extensions · MCP · open todos (hidden when empty)
 * Narrow bars drop the provider first, then shorten the path.
 *
 * Design: a polychromatic constellation, with the hues spent on the segments
 * that are ALWAYS visible (traffic, cache, cost, context, model) — not on
 * branch/session, which are often absent. Icon and value wear the segment hue
 * together: in=mdLink, out=success, cache hit=its own good/bad tone,
 * cost=warning, model=accent; the ramp meter walks the
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
 * MCP (pi 0.99+ ships it built in): the aux line shows the number of
 * connected servers, derived from the `mcp__<server>__<tool>` tools the
 * built-in extension registers, or a dim `0` while none is connected.
 * Extensions cannot read connection state, so failed or signed-out servers are
 * not counted; pi reports those itself after startup and in /mcp. Small
 * `cm` / `ts` tags mark the built-in `codemode` / `tool_search` tools while
 * they are active. The segment is hidden only when MCP support is disabled.
 *
 * pi-workspace-history: its plain `⟲ history` status is taken over: nothing
 * while snapshots are healthy, an error-toned `snapshot failed` on the aux
 * line when they break.
 *
 * Todos: the current task and done/total while any task is open; a finished
 * list leaves the bar.
 *
 * Icons only by default; PI_PRESET_FOOTER_LABELS=1 restores the word labels
 * (in/out/cache/ttl/warm/pkg/mcp) whenever they fit in two lines.
 *
 * Stats line legend:
 *   meter 58k/272k 21%   current context: used / window, percent
 *   in / out             session-cumulative prompt tokens (cached ones
 *                        included) and output tokens
 *   cache                the latest turn's cache hit rate
 *   $                    session cost; absent when the provider reports none
 *   ttl / warm           time left on the tracked prompt-cache entry and the
 *                        next idle refresh, from extensions/idle-keepwarm.ts
 *   ssh                  termius, only when its setup is not the default: the
 *                        global route (e.g. `direct`) and `+n` hosts with a
 *                        session allow or temporary level; the host label
 *                        while a call runs (extensions/termius.ts)
 *   skills               the skill store, only while skills are enabled for
 *                        this session: their count, `*` when one was enabled
 *                        through the tool and waits for a /reload
 *                        (extensions/skills-store.ts)
 *
 * Runtime: pi-preset/extensions/vibrant-footer.ts
 * Toggle:  /vibrant-footer
 */

import { basename, isAbsolute, relative, resolve, sep as pathSep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatClock, formatRemaining, type KeepwarmSnapshot, readSnapshot } from "../src/idle-keepwarm.ts";
import { readSkillsFooter, skillsFooterText } from "../src/skills-store/footer-state.ts";
import { footerIsEmpty, footerText, readFooter as readTermiusFooter, TERMIUS_STATUS_KEY } from "../src/termius/footer-state.ts";
import { messages as termiusMessages } from "../src/termius/messages.ts";
import { messages } from "../src/footer-messages.ts";

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
    cache: string;
    cacheTtl: string;
    cacheWarm: string;
    ssh: string;
    skills: string;
    cost: string;
    context: string;
    time: string;
    model: string;
    thinking: string;
    pkg: string;
    mcp: string;
    todo: string;
    todoActive: string;
    history: string;
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
    cache: "\u{f035b}", // nf-md-memory
    cacheTtl: "\u{f0150}", // nf-md-clock_outline
    cacheWarm: "\u{f0238}", // nf-md-fire
    ssh: "\u{f048d}", // nf-md-server_network
    skills: "\u{f0a66}", // nf-md-puzzle_outline
    cost: "\u{f01c8}", // nf-md-diamond_stone
    context: "\u{f029a}", // nf-md-gauge
    time: "\u{f051f}", // nf-md-timer_sand
    model: "\u{f0768}", // nf-md-atom
    thinking: "\u{f09d1}", // nf-md-brain
    pkg: "\u{f03d7}", // nf-md-package_variant_closed
    mcp: "\u{f06a5}", // nf-md-power_plug
    todo: "\u{f0756}", // nf-md-format_list_checks
    todoActive: "\u{f0995}", // nf-md-progress_check
    history: "\u{f02da}", // nf-md-history
};

const UNICODE_ICONS: IconSet = {
    path: "✧",
    branch: "⎇",
    session: "⌁",
    input: "↑",
    output: "↓",
    cache: "▤",
    cacheTtl: "⧗",
    cacheWarm: "♨",
    ssh: "⇄",
    skills: "⬢",
    cost: "◈",
    context: "▣",
    time: "◷",
    model: "π",
    thinking: "◆",
    pkg: "⬡",
    mcp: "⧉",
    todo: "☑",
    todoActive: "▸",
    history: "⟲",
};

/** Word labels next to the icons are opt-in; the icons carry the meaning on their own. */
function showWordLabels(): boolean {
    return process.env.PI_PRESET_FOOTER_LABELS === "1";
}

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

/** Cents once a session costs a dollar or more; a tenth of a cent below that. */
export function formatCost(cost: number): string {
    return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
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
 * Distinct package extensions currently contributing to the session.
 *
 * Tools and slash commands both carry a `sourceInfo`, and package-provided ones
 * are tagged `origin: "package"` — so unioning the two surfaces gives a count
 * that covers extensions shipping tools, commands, or both. Extensions that only
 * install a footer or an event hook stay invisible here; there is no public API
 * enumerating loaded extensions.
 *
 * Counted per extension, not per package source: the preset vendors its
 * extension set, so they all share one source. A vendored package
 * (`vendor/<name>/...`) counts once, any other extension file on its own.
 */
export function extensionKey(info: { source?: string; path?: string; origin?: string } | undefined): string | undefined {
    if (!info || info.origin !== "package") return undefined;
    const path = info.path?.replace(/\\/g, "/");
    if (path) {
        const vendored = path.match(/^(.*\/vendor\/[^/]+)\//);
        return vendored ? vendored[1] : path;
    }
    return info.source;
}

function packageCount(pi: ExtensionAPI): number {
    const sources = new Set<string>();
    const add = (info: { source?: string; path?: string; origin?: string } | undefined) => {
        const key = extensionKey(info);
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

/** Status key pi-workspace-history publishes through ctx.ui.setStatus(). */
const HISTORY_STATUS_KEY = "workspace-history";

/**
 * pi-workspace-history's status, restyled: nothing while snapshots are
 * healthy (its plain `⟲ history`), an error-toned "snapshot failed" when
 * they are not. Unknown texts from future versions are shown verbatim rather
 * than dropped.
 */
export function historySegment(t: ThemeLike, status: string | undefined, icons: IconSet): string | null {
    if (status === undefined) return null;
    const text = sanitizeStatusText(status);
    if (!text) return null;
    if (/fail/i.test(text)) return seg(t, icons.history, "error", messages().snapshotFailed, "error");
    if (/^⟲\s*history$/.test(text)) return null;
    return seg(t, icons.history, "success", text.replace(/^⟲\s*/, ""), "dim");
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

type PathMode = "full" | "abbrev" | "base";

/**
 * Where and who: path · branch · session on the left, provider · model ·
 * thinking on the right, the model being the line's one accent. When both do
 * not fit, the provider goes first, then the path shortens (`…` tail, then
 * the directory name); only then is the left side truncated.
 */
function renderTopLine(
    t: ThemeLike,
    ctx: ExtensionContext,
    branch: string | null,
    icons: IconSet,
    thinkingLevel: string,
    width: number,
): string {
    const sep = softSep(t);
    const home = process.env.HOME || process.env.USERPROFILE;
    const sessionName = ctx.sessionManager.getSessionName();
    const left = (mode: PathMode) =>
        join(
            [
                seg(t, icons.path, "mdLink", formatCwd(ctx.cwd, home, mode), "text"),
                branch ? seg(t, icons.branch, "mdQuote", branch, "thinkingText") : null,
                sessionName ? seg(t, icons.session, "customMessageLabel", sessionName, "thinkingText") : null,
            ],
            sep,
        );

    const provider = ctx.model?.provider;
    const model = t.bold(t.fg("accent", `${icons.model} ${ctx.model?.id ?? "no-model"}`));
    let thinking: string | null = null;
    if (ctx.model?.reasoning) {
        const style = thinkingStyle(thinkingLevel);
        thinking = t.fg(style.color, `${icons.thinking} ${style.label}`);
    }
    const right = (withProvider: boolean) =>
        join([withProvider && provider ? t.fg("muted", provider) : null, model, thinking], sep);

    const fits = (l: string, r: string) => visibleWidth(l) + 2 + visibleWidth(r) <= width;
    const attempts: Array<[PathMode, boolean]> = [
        ["full", true],
        ["abbrev", true],
        ["full", false],
        ["abbrev", false],
        ["base", false],
    ];
    for (const [mode, withProvider] of attempts) {
        const l = left(mode);
        const r = right(withProvider);
        if (fits(l, r)) return padBetween(l, r, width);
    }

    // Still too wide: keep the model whole while it leaves the path some room.
    const r = right(false);
    const room = width - visibleWidth(r) - 2;
    if (room >= 12) return padBetween(truncateToWidth(left("base"), room, t.fg("dim", "…")), r, width);
    return truncateToWidth(left("base") + " " + r, width, t.fg("dim", "…"));
}

/**
 * Prompt-cache lifetime and the next idle refresh, from idle-keepwarm's
 * snapshot. The countdown is coarse (whole minutes) because the bar repaints
 * every 30s; it turns warning-toned in the last 5 minutes.
 */
function keepwarmSegment(t: ThemeLike, state: KeepwarmSnapshot | undefined, icons: IconSet, labels: boolean): string | null {
    if (!state) return null;
    if (state.note) return seg(t, icons.cacheWarm, "dim", state.note, "dim");
    const parts: string[] = [];
    if (state.expiresAt !== undefined) {
        const left = state.expiresAt - Date.now();
        if (left <= 0) parts.push(lseg(t, icons.cacheTtl, "error", "cache", messages().expired, labels));
        else parts.push(lseg(t, icons.cacheTtl, left < 5 * 60_000 ? "warning" : "syntaxOperator", "ttl", formatRemaining(left), labels));
    }
    if (state.warming) {
        parts.push(lseg(t, icons.cacheWarm, "syntaxType", "warm", messages().now, labels));
    } else if (state.nextWarmAt !== undefined) {
        // "∞" marks a session whose refresh limit /keepwarm lifted.
        const count = t.fg("dim", `${state.warms > 0 ? ` ×${state.warms}` : ""}${state.unlimited ? " ∞" : ""}`);
        parts.push(lseg(t, icons.cacheWarm, "syntaxType", "warm", formatClock(state.nextWarmAt), labels) + count);
    } else if (state.limited) {
        // Refresh limit reached: a dimmed fire with the count, no next time.
        parts.push(lseg(t, icons.cacheWarm, "dim", "warm", `×${state.warms}`, labels));
    }
    return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * termius, only when its setup is not the default (footer-state.ts): the
 * route and `+n` at rest in warning tone, the host label in accent while a
 * call runs. Narrow bars drop the route when there is a count to show.
 */
function termiusSegment(t: ThemeLike, icons: IconSet, narrow: boolean): string | null {
    const state = readTermiusFooter();
    if (!state || footerIsEmpty(state)) return null;
    const color = state.active ? "accent" : "warning";
    return seg(t, icons.ssh, color, footerText(state, termiusMessages().routeName, narrow), color);
}

function renderStatsLines(
    t: ThemeLike,
    ctx: ExtensionContext,
    usage: UsageTotals,
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

    // Built without word labels unless PI_PRESET_FOOTER_LABELS=1; then the
    // labeled variant wins whenever it fits in two lines. Icons always stay.
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

        // Traffic: everything sent (cached prompt tokens included, which is what
        // a turn really costs in context) and everything generated. Icon AND value
        // wear the segment hue; a colored glyph next to gray digits doesn't register.
        const sent = usage.input + usage.cacheRead + usage.cacheWrite;
        if (sent || usage.output) {
            const parts: string[] = [];
            if (sent) parts.push(lseg(t, icons.input, "mdLink", "in", formatTokens(sent), labels));
            if (usage.output) parts.push(lseg(t, icons.output, "success", "out", formatTokens(usage.output), labels));
            segments.push(parts.join(" "));
        }

        // Cache: how much of the latest prompt came from cache; the tone degrades with it.
        if (usage.cacheHitRate !== undefined && (usage.cacheRead || usage.cacheWrite)) {
            const hit = usage.cacheHitRate;
            segments.push(lseg(t, icons.cache, cacheTone(hit), "cache", `${hit.toFixed(0)}%`, labels));
        }

        const keepwarm = keepwarmSegment(t, readSnapshot(), icons, labels);
        if (keepwarm) segments.push(keepwarm);

        const termius = termiusSegment(t, icons, width < 72);
        if (termius) segments.push(termius);

        // Skill store: session-enabled skills only (footer-state.ts).
        const skillsText = skillsFooterText(readSkillsFooter());
        if (skillsText) segments.push(seg(t, icons.skills, "accent", skillsText, "dim"));

        // Cost, when the provider reports one (proxies and most OAuth
        // subscriptions send cost.total = 0; the traffic segment covers volume).
        if (usage.cost > 0) {
            let usingOAuth = false;
            try {
                usingOAuth = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
            } catch {
                usingOAuth = false;
            }
            const amount = formatCost(usage.cost) + (usingOAuth ? " sub" : "");
            segments.push(seg(t, icons.cost, "warning", amount, "warning"));
        }

        // Session elapsed (only after ≥5s so empty sessions stay quiet)
        const elapsed = Date.now() - sessionStartMs;
        if (elapsed >= 5000) {
            segments.push(seg(t, icons.time, "dim", formatDuration(elapsed), "dim"));
        }
        return segments;
    };

    const labeled = showWordLabels() ? layoutSegments(buildSegments(true), sep, width, width) : undefined;
    return labeled?.fits ? labeled.lines : layoutSegments(buildSegments(false), sep, width, width).lines;
}

/** Done/total and the current task, while any task is open; a finished list leaves the bar. */
export function todoSummary(tasks: readonly TodoTask[]): { done: number; total: number; current?: string } | null {
    const done = tasks.filter((task) => task.status === "completed").length;
    if (tasks.length === 0 || done === tasks.length) return null;
    const current = tasks.find((task) => task.status === "in_progress");
    const label = current ? sanitizeStatusText(current.activeForm || current.subject || messages().working) : "";
    return { done, total: tasks.length, ...(label ? { current: label } : {}) };
}

/**
 * Aux line: snapshot failures, loaded extensions, MCP servers, and open todos.
 * Returns null when there is nothing to say, so a plain session keeps the bar
 * at two lines.
 */
function renderAuxLine(
    t: ThemeLike,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    icons: IconSet,
    width: number,
    historyStatus: string | undefined,
): string | null {
    const parts: string[] = [];

    const history = historySegment(t, historyStatus, icons);
    if (history) parts.push(history);

    const packages = packageCount(pi);
    if (packages > 0) {
        const label = showWordLabels() ? "pkg " : "";
        parts.push(seg(t, icons.pkg, "syntaxKeyword", `${label}${packages}`, "syntaxKeyword"));
    }

    // MCP: connected servers, always shown while MCP support is loaded; a dim 0
    // means none is connected. Dim cm/ts tags mark codemode / tool_search.
    const mcp = mcpSummary(pi);
    if (mcp.available || mcp.servers > 0 || mcp.codemode || mcp.toolSearch) {
        const tone = mcp.servers > 0 ? "syntaxFunction" : "dim";
        const label = showWordLabels() ? "mcp " : "";
        const tags = join([mcp.codemode ? "cm" : null, mcp.toolSearch ? "ts" : null], " ");
        parts.push(t.fg(tone, `${icons.mcp} ${label}${mcp.servers}`) + (tags ? t.fg("dim", ` ${tags}`) : ""));
    }

    const todos = todoSummary(latestTodos(ctx));
    if (todos) {
        parts.push(seg(t, icons.todo, "mdHeading", `${todos.done}/${todos.total}`, "mdHeading"));
        if (todos.current) parts.push(seg(t, icons.todoActive, "mdHeading", todos.current, "text"));
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
                        renderTopLine(t, ctx, branch, icons, pi.getThinkingLevel(), width),
                        ...renderStatsLines(t, ctx, usage, icons, sessionStartMs, width),
                    ];

                    const extensionStatuses = footerData.getExtensionStatuses();
                    const aux = renderAuxLine(t, pi, ctx, icons, width, extensionStatuses.get(HISTORY_STATUS_KEY));
                    if (aux) lines.push(aux);

                    if (extensionStatuses.size > 0) {
                        const sorted = Array.from(extensionStatuses.entries())
                            // idle-keepwarm's and termius's plain statuses are for pi's
                            // default footer; this bar renders the same state as stats
                            // segments. workspace-history is drawn on the aux line instead.
                            .filter(([key]) => key !== "keepwarm" && key !== TERMIUS_STATUS_KEY && key !== HISTORY_STATUS_KEY)
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
            ctx.ui.notify(enabled ? messages().footerOn : messages().footerOff, "info");
        },
    });
}
