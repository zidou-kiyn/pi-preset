// src/tools/monitor.ts
//
// `monitor` tool — a streaming-event background watch. Each stdout line (or
// WebSocket text frame) becomes one notification delivered into the agent's
// turn. This is distinct from bash_bg/run_in_background (one notification on
// completion): monitor is for per-event streams (tail -f | grep, poll loops,
// file watches, ws feeds), not one-shot "wait until done".

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    MONITOR_DEFAULT_TIMEOUT_MS,
    MONITOR_MAX_TIMEOUT_MS,
    type UiContext,
} from "../types.ts";
import { add, createRunningJob, errPathFor, newJobId, logPathFor } from "../registry.ts";
import { assertJobSlot, isBlankCommand, requireExistingCwd } from "../lifecycle.ts";
import { isWsSupported, type WsSpec } from "../monitor-ws.ts";
import {
    openWsMonitorSource,
    spawnCommandSource,
    type MonitorSource,
} from "../monitor-source.ts";
import { startMonitorSession } from "../monitor-session.ts";
import { textBlock } from "../format.ts";

type MonitorCtx = UiContext & { cwd: string };

interface MonitorParams {
    command?: string;
    ws?: WsSpec;
    description: string;
    persistent?: boolean;
    timeout_ms?: number;
}

export function registerMonitorTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "monitor",
        label: "Monitor",
        description:
            "Stream events from a long-running process: each stdout line (or WebSocket " +
            "text frame) becomes one notification, delivered while you keep working. " +
            "Use this for per-event streams — NOT for one-shot 'wait until done' (use " +
            "bash run_in_background for that). Exit ends the watch.",
        promptSnippet:
            "Stream per-event notifications from a process, log, poll loop, or WebSocket",
        promptGuidelines: [
            "monitor is for ONE-PER-EVENT streams; for a single 'tell me when done' use bash run_in_background with an `until` loop that exits, never an unbounded tail -f / while true.",
            "Every pipe stage must flush per line (grep --line-buffered, awk fflush(), never `head`), and the filter must match failures too (e.g. 'done|Traceback|Error|FAILED|Killed|OOM'), or a crash looks like silence. Merge stderr with 2>&1 if it matters.",
            "Poll remote APIs at 30s+, local checks at 0.5–1s, guard transient failures with `|| true`. persistent:true for session-long watches (stop with jobs kill); ws for WebSocket feeds instead of websocat.",
        ],
        parameters: Type.Object({
            command: Type.Optional(
                Type.String({ description: "Shell script; each stdout line is an event. Mutually exclusive with ws." })
            ),
            ws: Type.Optional(
                Type.Object(
                    {
                        url: Type.String({ description: "WebSocket URL (ws:// or wss://)" }),
                        protocols: Type.Optional(Type.Array(Type.String())),
                    },
                    { description: "WebSocket source; each text frame is an event. Mutually exclusive with command." }
                )
            ),
            description: Type.String({ description: "Specific description, shown on every notification." }),
            persistent: Type.Optional(
                Type.Boolean({ description: "Run for the whole session (no timeout). Stop via jobs action='kill'. Default false." })
            ),
            timeout_ms: Type.Optional(
                Type.Number({ description: "Kill after this deadline (default 300000, max 3600000). Ignored when persistent." })
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as MonitorParams;
            const mctx = ctx as MonitorCtx;

            // --- Validation: command XOR ws -------------------------------
            const hasCommand = typeof p.command === "string" && !isBlankCommand(p.command);
            const hasWs = !!p.ws && typeof p.ws.url === "string" && p.ws.url.length > 0;
            if (hasCommand && hasWs) {
                throw new Error("Provide either `command` or `ws`, not both.");
            }
            if (!hasCommand && !hasWs) {
                throw new Error("A monitor needs a `command` or a `ws` source.");
            }
            if (!p.description || p.description.trim().length === 0) {
                throw new Error("`description` is required (shown on every notification).");
            }
            if (hasWs && !isWsSupported()) {
                throw new Error(
                    "WebSocket is not available in this runtime (needs Node 22+). " +
                        `Use command: 'websocat ${p.ws!.url}' or 'wscat -c ${p.ws!.url}' instead.`
                );
            }
            if (hasCommand) requireExistingCwd(mctx.cwd);
            assertJobSlot(reg);

            const description = p.description.trim();
            const persistent = p.persistent === true;
            const timeoutMs = Math.min(
                p.timeout_ms && p.timeout_ms > 0 ? p.timeout_ms : MONITOR_DEFAULT_TIMEOUT_MS,
                MONITOR_MAX_TIMEOUT_MS
            );

            const id = newJobId("monitor", reg);
            const logPath = logPathFor(id);

            // Build the event source (command or ws) behind one seam, then hand
            // it to the session, which owns the streaming/terminal lifecycle.
            const source: MonitorSource = hasWs
                ? openWsMonitorSource(p.ws!, logPath)
                : spawnCommandSource({
                      command: p.command!,
                      cwd: mctx.cwd,
                      logPath,
                      errPath: errPathFor(id),
                  });

            const job = createRunningJob({
                id,
                name: description,
                command: source.label,
                pid: source.pid,
                logPath,
                toolCallId: _toolCallId,
                kind: "monitor",
            });
            add(reg, job);

            startMonitorSession({
                pi,
                reg,
                ctx: mctx,
                job,
                source,
                description,
                persistent,
                timeoutMs,
            });

            const sourceDesc = hasWs ? `WebSocket ${p.ws!.url}` : "command";
            const deadlineDesc = persistent
                ? "persistent (stop via jobs action='kill')"
                : `timeout ${Math.round(timeoutMs / 1000)}s`;
            return {
                content: [
                    textBlock(
                        `Monitor ${id} started — ${sourceDesc}, ${deadlineDesc}. ` +
                            `Events ("${description}") will arrive as notifications. ` +
                            `Output: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        },
    });
}
