/**
 * Check-ins for background jobs that outlive their estimate (pi-preset local
 * change).
 *
 * A background job reports once, when it exits. A job that never exits (a
 * server or watcher that already printed what was needed, a command waiting
 * for input that is not a y/n prompt, a hung network call) therefore never
 * reports: an idle agent waits for a notification that never comes, and a
 * `jobs attach` blocks the turn until the user presses Esc.
 *
 * `bash` and `agent_bg` take `expected_seconds`, the model's estimate of the
 * run time. Once a job is still running past it, the agent gets a check-in
 * with the elapsed time, how long ago the output last changed, and the log
 * tail, and decides whether to keep waiting or to kill the job. Further
 * check-ins come at 2x, 4x, ... the estimate, so a long healthy build is not
 * flooded but a stuck one is never silent for long. The check-in is delivered
 * like a completion (steer + triggerTurn) and wakes an idle agent; a
 * `jobs attach` that is following the job returns with it instead.
 *
 * Without an estimate a job checks in after PI_PRESET_BG_CHECK seconds
 * (default 300); `off` disables check-ins.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELIVER_STEER, EVENT, type Job } from "./types.ts";
import { buildTaskNotification } from "./notify.ts";
import { describeJob, formatDuration } from "./format.ts";
import { readLogTail } from "./registry.ts";

export const CHECK_IN_DEFAULT_SECONDS = 300;
/** Floor for the estimate and the spacing of check-ins. */
export const CHECK_IN_MIN_SECONDS = 30;
const CHECK_IN_TAIL_CHARS = 2_000;

/** Default estimate in seconds, or undefined when check-ins are off. */
export function readCheckInDefault(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = env.PI_PRESET_BG_CHECK?.trim();
    if (raw === undefined || raw === "") return CHECK_IN_DEFAULT_SECONDS;
    if (raw.toLowerCase() === "off") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : CHECK_IN_DEFAULT_SECONDS;
}

/** Milliseconds from the job's start to its first check-in, or undefined when check-ins are off. */
export function checkInAfterMs(
    requestedSeconds: number | undefined,
    env: NodeJS.ProcessEnv = process.env,
): number | undefined {
    const fallback = readCheckInDefault(env);
    if (fallback === undefined) return undefined;
    const seconds = typeof requestedSeconds === "number" && requestedSeconds > 0 ? requestedSeconds : fallback;
    return Math.max(seconds, CHECK_IN_MIN_SECONDS) * 1000;
}

/**
 * Elapsed time of the next check-in: the first of estimate, 2x, 4x, ... that
 * is at least the minimum spacing past `elapsedMs`. A command that slid into
 * the background just before its estimate does not check in right away.
 */
export function nextCheckInElapsedMs(expectedMs: number, elapsedMs: number): number {
    let at = expectedMs;
    while (at < elapsedMs + CHECK_IN_MIN_SECONDS * 1000) at *= 2;
    return at;
}

/** The parameter description shared by bash and agent_bg. */
export function expectedSecondsDescription(env: NodeJS.ProcessEnv = process.env): string {
    const fallback = readCheckInDefault(env);
    return (
        "Your estimate of how long this takes, in seconds. If it is still running in the background past that " +
        "(then 2x, 4x, ...), you get a check-in with its latest output to decide whether to keep waiting or kill it" +
        (fallback === undefined ? " (check-ins are off)." : ` (default ${fallback}).`)
    );
}

/** The check-in message for a job still running `elapsedMs` after its start. */
export function buildCheckIn(job: Job, expectedMs: number, elapsedMs: number, now: number = Date.now()): {
    content: string;
    summary: string;
} {
    const what = job.kind === "agent" ? "Agent" : "Background command";
    const summary =
        `${what} "${describeJob(job.name, job.command)}" is still running after ` +
        `${formatDuration(elapsedMs)} (estimate ${formatDuration(expectedMs)})`;

    let activity = "";
    try {
        activity = `Output last changed ${formatDuration(Math.max(0, now - statSync(job.logPath).mtimeMs))} ago.`;
    } catch {
        /* no log yet */
    }
    const tail = readLogTail(job, CHECK_IN_TAIL_CHARS).trimEnd();
    const next = formatDuration(nextCheckInElapsedMs(expectedMs, elapsedMs));
    const content =
        buildTaskNotification({
            taskId: job.id,
            toolUseId: job.toolCallId || undefined,
            outputFile: job.logPath,
            summary,
        }) +
        (activity ? `\n${activity}` : "") +
        (tail ? `\nLast output:\n${tail}` : "\nNo output yet.") +
        "\n\nCheck whether it is still making progress, has done its work without exiting (a server, a watcher, " +
        "a command waiting for input), or is stuck. Then keep waiting (next check-in at " +
        `${next}), or stop it with jobs action='kill' and fix the command.`;
    return { content, summary };
}

/**
 * Schedule the check-ins of a running job until `signal` aborts (the job's
 * completion aborts it). Uses the global setTimeout so node:test mock timers
 * drive it.
 */
export function armCheckIns(args: { pi: Pick<ExtensionAPI, "sendMessage">; job: Job; signal: AbortSignal }): void {
    const { pi, job, signal } = args;
    const expectedMs = job.checkInAfterMs;
    if (expectedMs === undefined || signal.aborted) return;

    let timer: NodeJS.Timeout | undefined;
    let dueAt = 0;
    const schedule = () => {
        const elapsed = Date.now() - job.startTime;
        dueAt = nextCheckInElapsedMs(expectedMs, elapsed);
        timer = setTimeout(fire, dueAt - elapsed);
        timer.unref();
    };
    const fire = () => {
        if (signal.aborted || job.status !== "running") return;
        // Timers may fire a millisecond early; never report less than was due.
        const elapsed = Math.max(Date.now() - job.startTime, dueAt);
        const message = buildCheckIn(job, expectedMs, elapsed);
        if (job.checkInWaiter) {
            job.checkInWaiter(message.content);
        } else {
            try {
                pi.sendMessage(
                    {
                        customType: EVENT.taskNotification,
                        content: message.content,
                        display: true,
                        details: { jobId: job.id, logPath: job.logPath, summary: message.summary },
                    },
                    DELIVER_STEER,
                );
            } catch (err) {
                console.error("[bg-tasks] check-in failed:", err);
            }
        }
        schedule();
    };
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    schedule();
}
