/**
 * Foreground auto-background timing (pi-preset local change).
 *
 * Under this extension a bash `timeout` is when a still-running foreground
 * command slides into the background, not when it is killed. Models read it
 * as a kill deadline and pass hundreds of seconds to protect long builds, so
 * a hung command held the session for minutes. The preset keeps foreground
 * waits short instead:
 *
 *   no timeout          -> PI_PRESET_BASH_BG_DEFAULT seconds (default 30)
 *   timeout above cap   -> PI_PRESET_BASH_BG_CAP seconds (default 60)
 *   smaller timeouts    -> unchanged
 *
 * Commands that are not allowed to auto-background (a bare `sleep`, which is
 * killed at the timeout instead) keep the timeout the model asked for, falling
 * back to upstream's 120s. Set either variable to `off` to get upstream timing.
 */

import { DEFAULT_TIMEOUT_MS } from "./types.ts";

export const PRESET_DEFAULT_SECONDS = 30;
export const PRESET_CAP_SECONDS = 60;

export interface TimeoutPolicy {
    /** Seconds used when the model passes no timeout; undefined = upstream default. */
    defaultSeconds: number | undefined;
    /** Upper bound in seconds; undefined = no cap. */
    capSeconds: number | undefined;
}

function readSeconds(raw: string | undefined, fallback: number): number | undefined {
    if (raw === undefined || raw.trim() === "") return fallback;
    if (raw.trim().toLowerCase() === "off") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readTimeoutPolicy(env: NodeJS.ProcessEnv = process.env): TimeoutPolicy {
    return {
        defaultSeconds: readSeconds(env.PI_PRESET_BASH_BG_DEFAULT, PRESET_DEFAULT_SECONDS),
        capSeconds: readSeconds(env.PI_PRESET_BASH_BG_CAP, PRESET_CAP_SECONDS),
    };
}

/** Milliseconds before a foreground command moves to the background. */
export function foregroundTimeoutMs(
    requestedSeconds: number | undefined,
    autoBackgroundAllowed: boolean,
    policy: TimeoutPolicy = readTimeoutPolicy(),
): number {
    const requested = typeof requestedSeconds === "number" && requestedSeconds > 0 ? requestedSeconds : undefined;
    if (!autoBackgroundAllowed) return requested !== undefined ? requested * 1000 : DEFAULT_TIMEOUT_MS;
    let seconds = requested ?? policy.defaultSeconds;
    if (seconds === undefined) return DEFAULT_TIMEOUT_MS;
    if (policy.capSeconds !== undefined) seconds = Math.min(seconds, policy.capSeconds);
    return seconds * 1000;
}

/** Text for the bash `timeout` parameter, matching the active policy. */
export function timeoutParameterDescription(policy: TimeoutPolicy = readTimeoutPolicy()): string {
    const defaultText = policy.defaultSeconds !== undefined ? `${policy.defaultSeconds}` : `${DEFAULT_TIMEOUT_MS / 1000}`;
    const capText = policy.capSeconds !== undefined ? `, at most ${policy.capSeconds}` : "";
    return (
        "Seconds before a still-running command moves to the background, where it keeps running and you are " +
        `notified when it finishes. It is NOT a kill deadline, so long builds need no large value (default ${defaultText}${capText}).`
    );
}
