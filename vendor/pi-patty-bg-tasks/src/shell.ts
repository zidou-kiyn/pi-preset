// src/shell.ts
/**
 * pi-preset: which shell runs a `command` spawn.
 *
 * Upstream spawned `bash -c <command>` through a PATH lookup, which ignored
 * `shellPath` from settings.json and, on Windows with WSL enabled, picked
 * C:\Windows\System32\bash.exe (the WSL launcher) ahead of Git Bash. Detached
 * with its output redirected to a file, that launcher exits 1 with an empty
 * log, so every bash / bash_bg / monitor call returned "(no output yet)".
 *
 * Resolution is pi's own getShellConfig (the one its built-in bash tool uses):
 * the configured shellPath, then Git Bash in its known Windows locations, then
 * bash on PATH. A legacy WSL launcher is only ever used as a last resort, and
 * then with the command written to stdin (commandTransport "stdin").
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** The subset of pi's ShellConfig this module relies on. */
export interface ShellConfigLike {
    shell: string;
    args: string[];
    commandTransport?: "argv" | "stdin";
}

export type ShellResolver = (customShellPath?: string) => ShellConfigLike;

/** How to launch one command: binary, argv, and the stdin payload if any. */
export interface ShellInvocation {
    bin: string;
    args: string[];
    /** Set when the command travels on stdin instead of argv. */
    stdin?: string;
}

export function resolveShellInvocation(
    command: string,
    shellPath?: string,
    resolve: ShellResolver = getShellConfig
): ShellInvocation {
    const config = resolve(shellPath || undefined);
    if (config.commandTransport === "stdin") {
        return { bin: config.shell, args: [...config.args], stdin: command };
    }
    return { bin: config.shell, args: [...config.args, command] };
}

/**
 * The session's effective shellPath: pi merges the project .pi/settings.json
 * over the global ~/.pi/agent/settings.json. Read on every call so a changed
 * setting applies without reloading. Undefined when unset or unavailable
 * (older pi, test doubles).
 */
export function sessionShellPath(pi: Pick<ExtensionAPI, "getSettings"> | undefined): string | undefined {
    try {
        const value = pi?.getSettings?.()?.shellPath;
        return typeof value === "string" && value.trim() ? value : undefined;
    } catch {
        return undefined;
    }
}
