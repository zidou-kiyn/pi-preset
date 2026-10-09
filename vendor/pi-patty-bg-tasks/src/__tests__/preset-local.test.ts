// pi-preset local changes: foreground timeout policy and the ref'd foreground child.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
    foregroundTimeoutMs,
    readTimeoutPolicy,
    timeoutParameterDescription,
} from "../timeout-policy.ts";

const preset = { defaultSeconds: 30, capSeconds: 60 };

describe("foreground timeout policy (pi-preset)", () => {
    it("defaults to 30s and caps at 60s", () => {
        assert.deepEqual(readTimeoutPolicy({}), preset);
        assert.equal(foregroundTimeoutMs(undefined, true, preset), 30_000);
        assert.equal(foregroundTimeoutMs(600, true, preset), 60_000);
        assert.equal(foregroundTimeoutMs(10, true, preset), 10_000, "smaller values are kept");
        assert.equal(foregroundTimeoutMs(0, true, preset), 30_000, "invalid values fall back to the default");
    });

    it("leaves commands that cannot auto-background alone", () => {
        assert.equal(foregroundTimeoutMs(300, false, preset), 300_000);
        assert.equal(foregroundTimeoutMs(undefined, false, preset), 120_000);
    });

    it("`off` restores upstream timing", () => {
        const off = readTimeoutPolicy({ PI_PRESET_BASH_BG_DEFAULT: "off", PI_PRESET_BASH_BG_CAP: "off" });
        assert.deepEqual(off, { defaultSeconds: undefined, capSeconds: undefined });
        assert.equal(foregroundTimeoutMs(undefined, true, off), 120_000);
        assert.equal(foregroundTimeoutMs(600, true, off), 600_000);
        assert.deepEqual(readTimeoutPolicy({ PI_PRESET_BASH_BG_DEFAULT: "45", PI_PRESET_BASH_BG_CAP: "junk" }), {
            defaultSeconds: 45,
            capSeconds: 60,
        });
    });

    it("tells the model the timeout backgrounds instead of killing", () => {
        const text = timeoutParameterDescription(preset);
        assert.match(text, /NOT a kill deadline/);
        assert.match(text, /default 30, at most 60/);
    });
});

describe("keepAlive spawn (pi-preset)", () => {
    // A process whose only pending work is the spawned child: with the child
    // unref'd Node exits before the child does, with keepAlive it waits.
    const spawnUrl = new URL("../spawn.ts", import.meta.url).href;
    const run = (keepAlive: boolean) => {
        const dir = mkdtempSync(join(tmpdir(), "patty-keepalive-"));
        const script = join(dir, "probe.mjs");
        writeFileSync(
            script,
            `import { spawnWithFileOutput } from ${JSON.stringify(spawnUrl)};\n` +
                `const r = spawnWithFileOutput({ command: "sleep 0.3", cwd: ${JSON.stringify(dir)}, logPath: ${JSON.stringify(join(dir, "out.log"))}, keepAlive: ${keepAlive} });\n` +
                `r.exit.then(() => { console.log("exited"); r.release(); });\n`,
        );
        return execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
            encoding: "utf8",
            cwd: fileURLToPath(new URL(".", import.meta.url)),
        });
    };

    it("keeps Node alive until the foreground child exits", () => {
        assert.equal(run(true).trim(), "exited");
    });

    it("an unref'd child lets Node exit first (the headless bug)", () => {
        assert.equal(run(false).trim(), "");
    });
});

describe("foreground bash live progress (pi-preset)", () => {
    // pi's bash renderer starts its "Elapsed" clock and output preview on the
    // first partial result, so one must arrive at once, and output within the
    // quick-completion window rather than after it.
    const harness = async () => {
        const { BackgroundRegistry } = await import("../state.ts");
        const { registerBashTool } = await import("../tools/bash.ts");
        let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
        const pi = { registerTool: (def: typeof tool) => { tool = def; }, sendMessage: () => {} };
        registerBashTool(pi as never, new BackgroundRegistry(), {} as never);
        const ctx = {
            cwd: process.cwd(),
            ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
        };
        return { tool: tool!, ctx };
    };

    it("reports a partial result immediately and streams output before 2s", async () => {
        const { tool, ctx } = await harness();
        const started = Date.now();
        const updates: Array<{ at: number; text: string }> = [];
        const onUpdate = (u: { content: Array<{ text: string }> }) =>
            updates.push({ at: Date.now() - started, text: u.content.map((c) => c.text).join("") });
        await tool.execute("t-live", { command: "echo first; sleep 1.2; echo second" }, undefined, onUpdate, ctx);
        assert.ok(updates.length >= 2, `expected partial updates, got ${updates.length}`);
        assert.equal(updates[0].text, "", "first update is the empty partial that starts the clock");
        assert.ok(updates[0].at < 100, `first update after ${updates[0].at}ms`);
        const firstOutput = updates.find((u) => u.text.includes("first"));
        assert.ok(firstOutput && firstOutput.at < 1000, `output streamed after ${firstOutput?.at}ms`);
    });
});

describe("private job log directory (pi-preset)", () => {
    it("is per-user, 0700, and refuses a directory it does not own", async () => {
        const { LOG_DIR, ensurePrivateLogDir, logPathFor } = await import("../registry.ts");
        const { lstatSync, mkdtempSync: mk, symlinkSync, chmodSync, statSync } = await import("node:fs");
        assert.notEqual(LOG_DIR, "/tmp/pi-bg", "no shared world-readable directory");
        assert.ok(logPathFor("abc").startsWith(LOG_DIR));
        if (typeof process.getuid !== "function") return;
        assert.match(LOG_DIR, new RegExp(`pi-bg-${process.getuid()}$`));

        const base = mk(join(tmpdir(), "patty-logdir-"));
        const fresh = join(base, "fresh");
        ensurePrivateLogDir(fresh);
        assert.equal(lstatSync(fresh).mode & 0o777, 0o700);

        const loose = join(base, "loose");
        ensurePrivateLogDir(loose);
        chmodSync(loose, 0o755);
        ensurePrivateLogDir(loose);
        assert.equal(statSync(loose).mode & 0o777, 0o700, "an existing loose directory is tightened");

        const link = join(base, "link");
        symlinkSync(fresh, link);
        assert.throws(() => ensurePrivateLogDir(link), /not a directory/);
    });

    it("job logs are created 0600", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        const { statSync } = await import("node:fs");
        const dir = mkdtempSync(join(tmpdir(), "patty-logmode-"));
        const logPath = join(dir, "job.log");
        const r = spawnWithFileOutput({ command: "echo hi", cwd: dir, logPath });
        await r.exit;
        if (typeof process.getuid === "function") assert.equal(statSync(logPath).mode & 0o777, 0o600);
    });
});
