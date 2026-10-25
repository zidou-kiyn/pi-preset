// src/spawn.ts
import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { ensurePrivateLogDir } from "./registry.ts";
import { resolveShellInvocation, type ShellResolver } from "./shell.ts";

/** How the child ended: an exit code, or the signal that killed it. Node
 *  reports `code === null` when the child died by signal (external kill, OOM),
 *  so the signal half is what tells a crash apart from a clean exit. */
export interface SpawnExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<SpawnExit>;
    /** Stop the child from holding Node's event loop open. Idempotent; a no-op
     *  unless the spawn passed `keepAlive: true`. (pi-preset) */
    release: () => void;
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run it in the user's shell (pi's getShellConfig, honouring
 * `shellPath`; pi-preset), or `file`/`fileArgs` to exec a binary directly
 * (e.g. agent_bg launching `pi -p`). The child is detached so the whole
 * process group can be signalled.
 */
export function spawnWithFileOutput(args: {
    command?: string;
    file?: string;
    fileArgs?: string[];
    cwd: string;
    logPath: string;
    /** When set, stderr is written here instead of merged into logPath. Used by
     *  the monitor tool so stdout is a clean event stream and stderr is captured
     *  separately (readable, but never emitted as an event). */
    errPath?: string;
    signal?: AbortSignal;
    /**
     * Keep the child ref'd until `release()` (pi-preset). A foreground command
     * must hold the event loop: in a headless `pi -p` nothing else does once
     * stdin is drained, so an unref'd child let Node exit in the middle of the
     * tool call. Background spawns keep the default (unref'd immediately).
     */
    keepAlive?: boolean;
    /**
     * The session's shellPath setting (pi-preset). Only used with `command`;
     * callers read it with sessionShellPath(pi). Unset = pi's default lookup.
     */
    shellPath?: string;
    /** Test seam: replaces pi's getShellConfig. */
    resolveShell?: ShellResolver;
}): SpawnResult {
    // Resolve the shell before opening any fd: getShellConfig throws when the
    // configured shellPath does not exist or no bash is found, and that error
    // (with its hint to set shellPath) is what the caller should see.
    const invocation = args.file
        ? { bin: args.file, args: args.fileArgs ?? [], stdin: undefined }
        : resolveShellInvocation(args.command ?? "", args.shellPath, args.resolveShell);
    const commandFromStdin = invocation.stdin !== undefined;

    ensureLogDir(args.logPath);
    const outFd = openSync(args.logPath, "w", 0o600);
    let errFd: number;
    try {
        errFd = args.errPath ? openSync(args.errPath, "w", 0o600) : outFd;
    } catch (err) {
        closeSync(outFd);
        throw err;
    }

    let proc;
    try {
        proc = spawn(invocation.bin, invocation.args, {
            // stdin carries the command for commandTransport "stdin" shells.
            stdio: [commandFromStdin ? "pipe" : "ignore", outFd, errFd],
            cwd: args.cwd,
            detached: true,
            windowsHide: true,
            env: { ...process.env },
        });
    } finally {
        closeSync(outFd);
        if (errFd !== outFd) closeSync(errFd);
    }

    if (commandFromStdin && proc.stdin) {
        // EPIPE when the shell exits before reading is reported by 'exit'.
        proc.stdin.on("error", () => {});
        proc.stdin.end(invocation.stdin);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<SpawnExit>((resolve) => {
        // Use 'exit' not 'close': 'close' waits for stdio to close, which
        // includes grandchild processes that inherit file descriptors (e.g.
        // `sleep 30 &`). 'exit' fires when the shell itself exits, returning
        // control immediately. Output still flushes fine — the kernel writes
        // directly to the file fd, no JS drain needed.
        proc.on("exit", (code, signal) => resolve({ code, signal }));
        proc.on("error", () => resolve({ code: 1, signal: null }));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        if (args.errPath) {
            try { unlinkSync(args.errPath); } catch { /* best-effort */ }
        }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        proc.unref();
    };
    if (!args.keepAlive) release();

    return { pid, logPath: args.logPath, exit, release };
}

/** The log dir is a constant (registry.LOG_DIR), so create and check it once
 *  per process instead of on every spawn. pi-preset: private (0700, owner
 *  checked) via ensurePrivateLogDir. */
const checkedLogDirs = new Set<string>();
function ensureLogDir(logPath: string): void {
    const dir = dirname(logPath);
    if (checkedLogDirs.has(dir)) return;
    ensurePrivateLogDir(dir);
    checkedLogDirs.add(dir);
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 *
 * pi-preset: Windows has no process groups (`process.kill(-pid)` throws and the
 * fallback killed only the shell, orphaning its children), so there the whole
 * tree is force-killed with `taskkill /F /T`, as pi's own killProcessTree does
 * (it is not exported from the package root). `signal` is ignored there.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    if (process.platform === "win32") {
        killWindowsTree(pid);
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Spawner for taskkill; replaceable in tests. */
export const windowsKill = { spawn };

function killWindowsTree(pid: number): void {
    // The trusted System32 binary, so cleanup never depends on PATH.
    const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    try {
        const child = windowsKill.spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            detached: true,
            windowsHide: true,
        });
        // A failed spawn emits 'error' asynchronously; never let it crash pi.
        child.once("error", () => {});
        child.unref();
    } catch {
        try {
            process.kill(pid);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
