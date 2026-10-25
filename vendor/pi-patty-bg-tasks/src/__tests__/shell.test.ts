// pi-preset: `command` spawns run in the shell pi resolves (getShellConfig +
// the session's shellPath) instead of whatever "bash" comes first on PATH.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { killProcessTree, spawnWithFileOutput, windowsKill } from "../spawn.ts";
import { resolveShellInvocation, sessionShellPath } from "../shell.ts";

const isWindows = process.platform === "win32";

/** A stand-in shell that records how it was invoked. */
function fakeShell(dir: string): string {
    const path = join(dir, "fake-shell");
    writeFileSync(path, '#!/bin/sh\necho "fake-shell argv: $*"\nif [ "$1" = "-s" ]; then echo "fake-shell stdin: $(cat)"; fi\n');
    chmodSync(path, 0o755);
    return path;
}

/** Run with process.platform and selected env vars swapped, then restore. */
function asPlatform<T>(platform: NodeJS.Platform, env: Record<string, string | undefined>, fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.defineProperty(process, "platform", { ...original, value: platform });
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        Object.defineProperty(process, "platform", original);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

describe("sessionShellPath (pi-preset)", () => {
    it("reads shellPath from the effective session settings", () => {
        assert.equal(sessionShellPath({ getSettings: () => ({ shellPath: "/opt/bash" }) } as never), "/opt/bash");
    });

    it("is undefined when unset, blank, unavailable, or throwing", () => {
        assert.equal(sessionShellPath({ getSettings: () => ({}) } as never), undefined);
        assert.equal(sessionShellPath({ getSettings: () => ({ shellPath: "  " }) } as never), undefined);
        assert.equal(sessionShellPath({} as never), undefined);
        assert.equal(sessionShellPath(undefined), undefined);
        assert.equal(
            sessionShellPath({
                getSettings: () => {
                    throw new Error("not bound yet");
                },
            } as never),
            undefined
        );
    });
});

describe("spawnWithFileOutput shell resolution (pi-preset)", { skip: isWindows }, () => {
    it("runs the command through the configured shellPath", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const logPath = join(dir, "out.log");
        const r = spawnWithFileOutput({ command: "echo hi", cwd: dir, logPath, shellPath: fakeShell(dir) });
        assert.equal((await r.exit).code, 0);
        assert.equal(readFileSync(logPath, "utf8").trim(), "fake-shell argv: -c echo hi");
    });

    it("without shellPath uses pi's default shell", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const logPath = join(dir, "out.log");
        const r = spawnWithFileOutput({ command: "echo hi", cwd: dir, logPath });
        assert.equal((await r.exit).code, 0);
        assert.equal(readFileSync(logPath, "utf8").trim(), "hi");
        assert.deepEqual(resolveShellInvocation("echo hi"), {
            bin: getShellConfig().shell,
            args: [...getShellConfig().args, "echo hi"],
        });
    });

    it("a missing shellPath fails loudly and leaves no log behind", () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const logPath = join(dir, "out.log");
        assert.throws(
            () => spawnWithFileOutput({ command: "echo hi", cwd: dir, logPath, shellPath: join(dir, "nope") }),
            /Custom shell path not found/
        );
        assert.equal(existsSync(logPath), false);
    });

    it("writes the command to stdin for commandTransport 'stdin' shells", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const shell = fakeShell(dir);
        const logPath = join(dir, "out.log");
        const r = spawnWithFileOutput({
            command: "echo hi",
            cwd: dir,
            logPath,
            resolveShell: () => ({ shell, args: ["-s"], commandTransport: "stdin" }),
        });
        assert.equal((await r.exit).code, 0);
        assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
            "fake-shell argv: -s",
            "fake-shell stdin: echo hi",
        ]);
    });

    it("stdin transport runs the command in a real shell", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const logPath = join(dir, "out.log");
        const r = spawnWithFileOutput({
            command: "echo from-stdin; exit 3",
            cwd: dir,
            logPath,
            resolveShell: () => ({ shell: "/bin/sh", args: ["-s"], commandTransport: "stdin" }),
        });
        assert.equal((await r.exit).code, 3);
        assert.equal(readFileSync(logPath, "utf8").trim(), "from-stdin");
    });

    it("file spawns (agent_bg) never consult the shell", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-shell-"));
        const logPath = join(dir, "out.log");
        const r = spawnWithFileOutput({
            file: "/bin/echo",
            fileArgs: ["direct"],
            cwd: dir,
            logPath,
            resolveShell: () => {
                throw new Error("shell resolved for a file spawn");
            },
        });
        assert.equal((await r.exit).code, 0);
        assert.equal(readFileSync(logPath, "utf8").trim(), "direct");
    });
});

describe("Windows shell selection (pi-preset)", { skip: isWindows }, () => {
    // Simulated on POSIX: process.platform is win32, `where bash.exe` (a stub on
    // PATH) answers System32\bash.exe first, and Git Bash sits at its
    // Program Files location. On POSIX a backslash is an ordinary filename
    // character, so "<dir>\Git\bin\bash.exe" is created as one file.
    it("prefers Git Bash over a System32 WSL launcher listed first on PATH", () => {
        const programFiles = mkdtempSync(join(tmpdir(), "patty-pf-"));
        const gitBash = `${programFiles}\\Git\\bin\\bash.exe`;
        writeFileSync(gitBash, "");
        const stubs = mkdtempSync(join(tmpdir(), "patty-where-"));
        writeFileSync(join(stubs, "where"), "#!/bin/sh\necho 'C:\\Windows\\System32\\bash.exe'\n");
        chmodSync(join(stubs, "where"), 0o755);

        const invocation = asPlatform(
            "win32",
            {
                ProgramFiles: programFiles,
                "ProgramFiles(x86)": undefined,
                SystemRoot: "C:\\Windows",
                PATH: `${stubs}:${process.env.PATH ?? ""}`,
            },
            () => resolveShellInvocation("echo hi")
        );
        assert.equal(invocation.bin, gitBash);
        assert.deepEqual(invocation.args, ["-c", "echo hi"]);
        assert.doesNotMatch(invocation.bin, /System32/i);
    });

    it("a shellPath setting wins over every lookup", () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-pf-"));
        const custom = join(dir, "my-bash.exe");
        writeFileSync(custom, "");
        const invocation = asPlatform("win32", { ProgramFiles: dir, SystemRoot: "C:\\Windows" }, () =>
            resolveShellInvocation("echo hi", custom)
        );
        assert.deepEqual(invocation, { bin: custom, args: ["-c", "echo hi"] });
    });

    it("a WSL launcher that is the only bash gets the command on stdin, not argv", () => {
        const wsl = "C:\\Windows\\System32\\bash.exe";
        const invocation = resolveShellInvocation("echo hi", undefined, () => ({
            shell: wsl,
            args: ["-s"],
            commandTransport: "stdin",
        }));
        assert.deepEqual(invocation, { bin: wsl, args: ["-s"], stdin: "echo hi" });
    });
});

describe("killProcessTree on Windows (pi-preset)", () => {
    const realSpawn = windowsKill.spawn;
    afterEach(() => {
        windowsKill.spawn = realSpawn;
    });

    it("kills the whole tree with System32 taskkill /F /T", () => {
        const calls: { file: string; args: readonly string[] }[] = [];
        windowsKill.spawn = ((file: string, args: readonly string[]) => {
            calls.push({ file, args });
            return { once: () => {}, unref: () => {} };
        }) as never;
        asPlatform("win32", { SystemRoot: "D:\\Win" }, () => killProcessTree(4242, "SIGTERM"));
        assert.deepEqual(calls, [{ file: "D:\\Win\\System32\\taskkill.exe", args: ["/F", "/T", "/PID", "4242"] }]);
    });

    it("still ignores invalid pids", () => {
        let called = false;
        windowsKill.spawn = (() => {
            called = true;
        }) as never;
        asPlatform("win32", {}, () => {
            killProcessTree(0);
            killProcessTree(undefined);
        });
        assert.equal(called, false);
    });
});

describe("tools pass the session shellPath (pi-preset)", { skip: isWindows }, () => {
    type Tool = {
        name?: string;
        execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
    };

    async function harness(register: (pi: never, reg: never) => void) {
        const { BackgroundRegistry } = await import("../state.ts");
        const dir = mkdtempSync(join(tmpdir(), "patty-tool-shell-"));
        const shell = fakeShell(dir);
        let tool: Tool | undefined;
        const pi = {
            registerTool: (def: Tool) => {
                tool = def;
            },
            sendMessage: () => {},
            // What pi returns: project .pi/settings.json merged over the global file.
            getSettings: () => ({ shellPath: shell }),
        };
        const reg = new BackgroundRegistry();
        register(pi as never, reg as never);
        const ctx = {
            cwd: dir,
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        };
        return { tool: tool!, reg, ctx };
    }

    async function logOf(reg: { jobs: Map<string, { logPath: string; exit?: unknown }> }): Promise<string> {
        const job = [...reg.jobs.values()][0]!;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
            const text = existsSync(job.logPath) ? readFileSync(job.logPath, "utf8") : "";
            if (text.includes("fake-shell")) return text.trim();
            await new Promise((r) => setTimeout(r, 20));
        }
        return readFileSync(job.logPath, "utf8").trim();
    }

    it("bash_bg", async () => {
        const { registerBashBgTool } = await import("../tools/bash-bg.ts");
        const { tool, reg, ctx } = await harness(registerBashBgTool as never);
        await tool.execute("t1", { command: "echo hi" }, undefined, undefined, ctx);
        assert.equal(await logOf(reg as never), "fake-shell argv: -c echo hi");
    });

    it("bash (run_in_background and foreground)", async () => {
        const { registerBashTool } = await import("../tools/bash.ts");
        const register = (pi: never, reg: never) => registerBashTool(pi, reg, {} as never);
        const bg = await harness(register as never);
        await bg.tool.execute("t1", { command: "echo hi", run_in_background: true }, undefined, undefined, bg.ctx);
        assert.equal(await logOf(bg.reg as never), "fake-shell argv: -c echo hi");

        const fg = await harness(register as never);
        const res = (await fg.tool.execute("t2", { command: "echo hi" }, undefined, undefined, fg.ctx)) as {
            content: { text: string }[];
        };
        assert.match(res.content[0]!.text, /fake-shell argv: -c echo hi/);
    });

    it("monitor", async () => {
        const { registerMonitorTool } = await import("../tools/monitor.ts");
        const { tool, reg, ctx } = await harness(registerMonitorTool as never);
        await tool.execute("t1", { command: "echo hi", description: "d" }, undefined, undefined, ctx);
        assert.equal(await logOf(reg as never), "fake-shell argv: -c echo hi");
    });
});
