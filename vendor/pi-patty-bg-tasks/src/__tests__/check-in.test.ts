/**
 * pi-preset: check-ins for background jobs that outlive their estimate.
 */

import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    armCheckIns,
    checkInAfterMs,
    expectedSecondsDescription,
    nextCheckInElapsedMs,
} from "../check-in.ts";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { registerJobsTool } from "../tools/jobs.ts";
import { EVENT, type Job, type UiContext } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-check-in-${process.pid}`);

interface Sent {
    message: { customType: string; content: string; details?: { summary?: string } };
    options?: { deliverAs?: string; triggerTurn?: boolean };
}

function mkJob(id: string, checkInMs: number | undefined, output = "listening on :3000\n"): Job {
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${id}.log`);
    writeFileSync(logPath, output);
    const job = createRunningJob({ id, command: "npm run dev", pid: 0, logPath, toolCallId: "tc-1" });
    job.checkInAfterMs = checkInMs;
    return job;
}

function fakePi(sent: Sent[]) {
    return {
        sendMessage: (message: Sent["message"], options?: Sent["options"]) => sent.push({ message, options }),
    };
}

describe("check-in timing", () => {
    it("uses the estimate, the PI_PRESET_BG_CHECK default, a 30s floor, and off", () => {
        assert.equal(checkInAfterMs(120, {}), 120_000);
        assert.equal(checkInAfterMs(undefined, {}), 300_000);
        assert.equal(checkInAfterMs(5, {}), 30_000);
        assert.equal(checkInAfterMs(undefined, { PI_PRESET_BG_CHECK: "90" }), 90_000);
        assert.equal(checkInAfterMs(undefined, { PI_PRESET_BG_CHECK: "nonsense" }), 300_000);
        assert.equal(checkInAfterMs(120, { PI_PRESET_BG_CHECK: "off" }), undefined);
        assert.match(expectedSecondsDescription({}), /default 300/);
        assert.match(expectedSecondsDescription({ PI_PRESET_BG_CHECK: "off" }), /check-ins are off/);
    });

    it("doubles the estimate and keeps at least 30s after the current time", () => {
        assert.equal(nextCheckInElapsedMs(60_000, 0), 60_000);
        // Just fired at 60s: the next is at 120s.
        assert.equal(nextCheckInElapsedMs(60_000, 60_000), 120_000);
        // Slid into the background at 30s with a 30s estimate: not right away.
        assert.equal(nextCheckInElapsedMs(30_000, 30_000), 60_000);
        assert.equal(nextCheckInElapsedMs(60_000, 59_900), 120_000);
    });
});

describe("armCheckIns (fake timers)", () => {
    afterEach(() => {
        mock.timers.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    it("wakes the agent at the estimate and at 2x, and stops when the job ends", () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
        const sent: Sent[] = [];
        const job = mkJob("b-dev", 60_000);
        const ac = new AbortController();
        armCheckIns({ pi: fakePi(sent), job, signal: ac.signal });

        mock.timers.tick(59_000);
        assert.equal(sent.length, 0);
        mock.timers.tick(1_000);
        assert.equal(sent.length, 1);
        const first = sent[0]!;
        assert.equal(first.message.customType, EVENT.taskNotification);
        assert.deepEqual(first.options, { deliverAs: "steer", triggerTurn: true });
        assert.match(first.message.content, /<task_id>b-dev<\/task_id>/);
        assert.doesNotMatch(first.message.content, /<status>/);
        assert.match(first.message.details!.summary!, /still running after 1m0s \(estimate 1m0s\)/);
        assert.match(first.message.content, /listening on :3000/);
        assert.match(first.message.content, /next check-in at 2m0s/);
        assert.match(first.message.content, /jobs action='kill'/);

        mock.timers.tick(60_000);
        assert.equal(sent.length, 2);

        ac.abort();
        mock.timers.tick(240_000);
        assert.equal(sent.length, 2);
    });

    it("stays silent for a job that already finished or has no estimate", () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
        const sent: Sent[] = [];
        const done = mkJob("b-done", 60_000);
        armCheckIns({ pi: fakePi(sent), job: done, signal: new AbortController().signal });
        done.status = "completed";
        armCheckIns({ pi: fakePi(sent), job: mkJob("b-off", undefined), signal: new AbortController().signal });
        mock.timers.tick(600_000);
        assert.equal(sent.length, 0);
    });

    it("ends a jobs attach instead of notifying, and the completion still notifies later", async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
        const sent: Sent[] = [];
        let tool:
            | { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> }
            | undefined;
        const pi = { ...fakePi(sent), registerTool: (def: typeof tool) => (tool = def) };
        const reg = new BackgroundRegistry();
        registerJobsTool(pi as never, reg);
        const ctx = {
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        } as unknown as UiContext;

        const job = mkJob("b-attach", 60_000);
        add(reg, job);
        armCheckIns({ pi, job, signal: new AbortController().signal });

        const pending = tool!.execute("t1", { action: "attach", jobId: job.id }, undefined, undefined, ctx);
        mock.timers.tick(60_000);
        const result = await pending;
        assert.match(result.content[0]!.text, /still running after 1m0s/);
        assert.equal(sent.length, 0, "the attach result carries the check-in");
        assert.equal(job.notified, false, "the completion notification must still fire");
        assert.equal(job.checkInWaiter, undefined);

        // Not attached any more: the next check-in goes out as a message.
        mock.timers.tick(60_000);
        assert.equal(sent.length, 1);
    });
});
