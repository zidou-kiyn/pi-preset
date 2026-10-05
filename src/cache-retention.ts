/**
 * Decision logic for extensions/cache-retention.ts, kept pure for tests.
 *
 * pi selects prompt-cache retention only through the PI_CACHE_RETENTION env
 * var ("long" = 1h Anthropic TTL / 24h OpenAI Responses). An explicit,
 * non-empty value always wins over the preset default.
 */

export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
export const DEFAULT_CACHE_RETENTION = "long";

/** Set PI_CACHE_RETENTION to "long" when unset or empty. Returns whether it wrote. */
export function applyDefaultCacheRetention(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[CACHE_RETENTION_ENV]) return false;
	env[CACHE_RETENTION_ENV] = DEFAULT_CACHE_RETENTION;
	return true;
}
