/**
 * idle-keepwarm — keep the Anthropic prompt cache warm for as long as pi's
 * interactive UI stays open.
 *
 * Why: pi's built-in cache warmer (settings `cacheWarming`) stops idle warming
 * 30 minutes after the last real request, while a 1h cache entry is first
 * refreshed at 54 minutes. With PI_CACHE_RETENTION=long (extensions/
 * cache-retention.ts) that means nothing refreshes the cache once you have
 * been idle for an hour, and the next message rewrites the whole prefix.
 *
 * How: every real Anthropic request of the session is captured in
 * `before_provider_request`. While the agent is idle, shortly before the
 * entry expires (90% of the TTL), the captured payload is re-sent unchanged
 * except for `max_tokens: 1`. The provider serves the identical prefix from
 * cache and restarts its lifetime. Nothing enters the conversation; each
 * refresh is recorded as a `pi-preset-keepwarm` custom session entry. During
 * runs pi's own `cacheWarming: "streaming"` (the default) covers long tool
 * calls, and this extension stops pi's idle warming so both never refresh.
 *
 * Guards — the cache write is the billed part on a Claude subscription:
 *   - a refresh that would fire after (or within 5s of) expiry, e.g. after
 *     the machine slept, is skipped; warming resumes after the next message
 *   - a refresh that misses the cache stops warming at once with a warning
 *   - model switch, compaction, and /tree navigation pause warming until the
 *     next real request
 *
 * Env:
 *   PI_PRESET_KEEPWARM=off               disable the extension
 *   PI_PRESET_KEEPWARM_MAX_IDLE=3h       stop after this long without a real
 *                                        request (default: no limit)
 *
 * Runtime: pi-preset/extensions/idle-keepwarm.ts
 * Command: none (status bar segment "keepwarm" only)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	detectRetention,
	formatClock,
	formatRemaining,
	isCacheMiss,
	isWarmReplay,
	LATE_MARGIN_MS,
	type KeepwarmConfig,
	type KeepwarmSnapshot,
	publishSnapshot,
	type Retention,
	readConfig,
	refreshDelayMs,
	ttlMsFor,
	type WarmUsage,
	warmPayload,
} from "../src/idle-keepwarm.ts";

const STATUS_KEY = "keepwarm";
const ENTRY_TYPE = "pi-preset-keepwarm";

interface Captured {
	payload: Record<string, unknown>;
	model: NonNullable<ExtensionContext["model"]>;
	retention: Retention;
	ttlMs: number;
}

/** Repaint cadence of the countdown; the footer shows whole minutes. */
const TICK_MS = 30_000;

export default function idleKeepwarm(pi: ExtensionAPI): void {
	const config: KeepwarmConfig = readConfig();
	if (!config.enabled) return;

	let ctxRef: ExtensionContext | undefined;
	let captured: Captured | undefined;
	/** Start of the last request that touched the cache entry; TTLs run from request start. */
	let lastTouch = 0;
	/** Start of the last real (non-refresh) request, for the optional idle limit. */
	let lastRealRequest = 0;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	let note: string | undefined;
	let warms = 0;

	const setStatus = (text: string | undefined): void => {
		try {
			if (ctxRef?.hasUI) ctxRef.ui.setStatus(STATUS_KEY, text);
		} catch {
			// UI can be gone after session replacement.
		}
	};

	let ticker: ReturnType<typeof setInterval> | undefined;

	const snapshot = (): KeepwarmSnapshot | undefined => {
		if (!captured) return note ? { warms, note } : undefined;
		return {
			expiresAt: lastTouch + captured.ttlMs,
			...(timer ? { nextWarmAt: lastTouch + refreshDelayMs(captured.ttlMs, config.everyMs) } : {}),
			warms,
			...(inflight ? { warming: true } : {}),
		};
	};

	/** Plain-text form for pi's default footer; vibrant-footer renders the snapshot itself. */
	const statusText = (state: KeepwarmSnapshot | undefined): string | undefined => {
		if (!state) return undefined;
		if (state.note) return `keepwarm: ${state.note}`;
		const parts: string[] = [];
		if (state.expiresAt !== undefined) {
			const left = state.expiresAt - Date.now();
			parts.push(left > 0 ? `cache ${formatRemaining(left)}` : "cache expired");
		}
		if (state.warming) parts.push("warming");
		else if (state.nextWarmAt !== undefined) {
			parts.push(`warm ${formatClock(state.nextWarmAt)}${state.warms > 0 ? ` (${state.warms}x)` : ""}`);
		}
		return parts.join(" · ") || undefined;
	};

	const render = (): void => {
		const state = snapshot();
		publishSnapshot(state);
		setStatus(statusText(state));
		if (state?.expiresAt !== undefined && !ticker) {
			ticker = setInterval(() => render(), TICK_MS);
			ticker.unref?.();
		} else if (state?.expiresAt === undefined && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	const notify = (message: string, level: "info" | "warning" = "info"): void => {
		try {
			ctxRef?.ui.notify(`keepwarm: ${message}`, level);
		} catch {}
	};

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const abortInflight = (): void => {
		inflight?.abort();
		inflight = undefined;
	};

	/** Forget the captured request; the next real request re-arms warming. */
	const pause = (why: string): void => {
		captured = undefined;
		clearTimer();
		abortInflight();
		note = why;
		render();
	};

	const schedule = (): void => {
		clearTimer();
		if (!captured || running || !ctxRef?.hasUI) return render();
		const at = lastTouch + refreshDelayMs(captured.ttlMs, config.everyMs);
		timer = setTimeout(() => void refresh(), Math.max(0, at - Date.now()));
		timer.unref?.();
		note = undefined;
		render();
	};

	const refresh = async (): Promise<void> => {
		timer = undefined;
		const last = captured;
		const ctx = ctxRef;
		if (!last || !ctx || running || !ctx.isIdle()) return render();

		if (Date.now() - lastRealRequest >= config.maxIdleMs) return pause("idle limit reached");
		const model = ctx.model;
		if (!model || model.provider !== last.model.provider || model.id !== last.model.id) {
			return pause("model changed");
		}
		// Timer ran late (sleep, blocked loop): the entry is likely gone and a
		// refresh would be a full cache write, the billed part.
		if (Date.now() >= lastTouch + last.ttlMs - LATE_MARGIN_MS) return pause("cache expired, resumes on next message");

		const controller = new AbortController();
		inflight = controller;
		const sentAt = Date.now();
		render();
		try {
			const message = await ctx.modelRegistry
				.streamSimple(
					last.model,
					{ systemPrompt: "", messages: [{ role: "user", content: "keepwarm", timestamp: sentAt }] },
					{
						maxTokens: 1,
						maxRetries: 0,
						signal: controller.signal,
						sessionId: ctx.sessionManager.getSessionId(),
						cacheRetention: last.retention,
						onPayload: () => warmPayload(last.payload),
					},
				)
				.result();
			// Superseded by a real request or a pause while in flight.
			if (controller.signal.aborted || inflight !== controller || captured !== last) return;
			inflight = undefined;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return pause(`refresh failed (${message.errorMessage ?? message.stopReason}), resumes on next message`);
			}
			const usage: WarmUsage = message.usage;
			pi.appendEntry(ENTRY_TYPE, { provider: message.provider, model: message.model, usage });
			if (isCacheMiss(usage)) {
				notify(
					`refresh missed the cache (read ${usage.cacheRead ?? 0}, wrote ${usage.cacheWrite ?? 0} tokens); stopped until the next message`,
					"warning",
				);
				return pause("stopped after a cache miss");
			}
			warms++;
			lastTouch = sentAt;
			schedule();
		} catch (error) {
			if (controller.signal.aborted || inflight !== controller) return;
			inflight = undefined;
			pause(`refresh failed (${(error as Error)?.message ?? String(error)}), resumes on next message`);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		clearTimer();
		abortInflight();
		ctxRef = ctx;
		captured = undefined;
		note = undefined;
		running = false;
		warms = 0;
		render();
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		abortInflight();
		captured = undefined;
		note = undefined;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		publishSnapshot(undefined);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object" || isWarmReplay(payload)) return undefined;
		ctxRef = ctx;
		const model = ctx.model;
		const retention = model?.api === "anthropic-messages" ? detectRetention(payload) : undefined;
		abortInflight(); // a real request supersedes an in-flight refresh
		if (!model || !retention || payload.model !== model.id) {
			captured = undefined;
			return undefined;
		}
		captured = {
			payload: structuredClone(payload),
			model,
			retention,
			ttlMs: ttlMsFor(model.promptCache, retention),
		};
		lastTouch = Date.now();
		lastRealRequest = lastTouch;
		warms = 0;
		if (!running) schedule();
		return undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctxRef = ctx;
		running = true;
		clearTimer();
		abortInflight();
		render();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		ctxRef = ctx;
		running = false;
		schedule();
	});

	// The captured prefix is no longer what the next request extends.
	pi.on("model_select", async () => pause("model changed"));
	pi.on("session_compact", async () => pause("compacted"));
	pi.on("session_tree", async () => pause("tree navigation"));

	// While idle this extension owns refreshes; during runs pi's streaming warmer does.
	pi.on("cache_warming_decision", async () => (!running && captured ? { action: "stop" as const } : undefined));
}
