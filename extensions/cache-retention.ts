/**
 * cache-retention — default PI_CACHE_RETENTION to "long" inside pi.
 *
 * Why: pi has no settings.json key for prompt-cache retention; the only switch
 * is the PI_CACHE_RETENTION env var, read per request (pi-ai provider-env) and
 * by the cache warmer when it picks the model's promptCache tier. Setting it in
 * a shell rc misses every shell that was started earlier (long-lived tmux
 * panes, desktop launchers). Setting it on process.env at extension load
 * covers every request of this process and every child it spawns
 * (`pi -p` subagents inherit the env).
 *
 * Effect: Anthropic requests use a 1h cache_control TTL, OpenAI Responses
 * requests ask for 24h retention where the provider's compat allows it, and
 * cache warming schedules against the model's `promptCache.long` lifetime.
 *
 * An explicit value is respected: PI_CACHE_RETENTION=short (or anything else
 * non-empty) in the environment wins over this default.
 *
 * Runtime: pi-preset/extensions/cache-retention.ts
 * Command: none (load-time side effect only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyDefaultCacheRetention } from "../src/cache-retention.ts";

export default function cacheRetention(_pi: ExtensionAPI): void {
	applyDefaultCacheRetention();
}
