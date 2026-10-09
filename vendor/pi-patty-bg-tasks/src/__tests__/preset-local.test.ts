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
