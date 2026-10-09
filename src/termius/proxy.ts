/**
 * Proxy settings for the Termius MCP server's SSH connections.
 *
 * `/termius proxy` stores a choice in the server's config.json:
 *   - unset ("system"): follow pi's ALL_PROXY / HTTPS_PROXY / HTTP_PROXY and
 *     NO_PROXY (any case), read here and handed to the server explicitly,
 *     because MCP stdio servers do not reliably inherit pi's environment;
 *   - a URL (socks5://, socks5h://, socks4://, socks4a://, http://);
 *   - "off": always connect directly.
 * The server applies it only to hosts without a Termius jump host chain
 * (vendor/termius-mcp/termius/core/proxy.py).
 */

export const PROXY_SCHEMES = ["socks5", "socks5h", "socks4", "socks4a", "http"] as const;

const SYSTEM_PROXY_VARS = ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const SYSTEM_NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];
const LOOPBACK = ["localhost", "127.0.0.0/8", "::1"];

export interface ProxySettings {
	/** undefined = follow the system variables; "off" = direct; otherwise a proxy URL. */
	proxy?: string;
	/** Hosts that bypass a configured proxy URL; undefined = the server's default (loopback, private, link-local, *.local). */
	proxyBypass?: string[];
}

/** An error message for an unusable proxy URL, or undefined when it is fine. */
export function proxyUrlError(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "not a URL (example: socks5://127.0.0.1:7890)";
	}
	const scheme = parsed.protocol.replace(/:$/u, "");
	if (!(PROXY_SCHEMES as readonly string[]).includes(scheme)) return `unsupported scheme ${scheme}: use ${PROXY_SCHEMES.join(", ")}`;
	if (!parsed.hostname) return "the URL has no host";
	return undefined;
}

/** The URL without user:password, for display. */
export function redactProxyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			return `${parsed.protocol}//***@${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
		}
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return "(invalid URL)";
	}
}

function systemProxy(env: NodeJS.ProcessEnv): { name: string; url: string } | undefined {
	for (const name of SYSTEM_PROXY_VARS) {
		const url = env[name]?.trim();
		if (url) return { name, url };
	}
	return undefined;
}

function systemNoProxy(env: NodeJS.ProcessEnv): string[] {
	return SYSTEM_NO_PROXY_VARS.flatMap((name) => (env[name] ?? "").split(",")).map((item) => item.trim()).filter(Boolean);
}

/** Environment for the MCP server process that carries the effective proxy choice. */
export function proxyServerEnv(settings: ProxySettings, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	if (settings.proxy === "off") return { TERMIUS_MCP_PROXY: "off" };
	if (settings.proxy) {
		const out: Record<string, string> = { TERMIUS_MCP_PROXY: settings.proxy, TERMIUS_MCP_PROXY_SOURCE: "/termius proxy" };
		if (settings.proxyBypass) out.TERMIUS_MCP_NO_PROXY = settings.proxyBypass.join(",");
		return out;
	}
	const system = systemProxy(env);
	if (!system) return { TERMIUS_MCP_PROXY: "off" };
	return {
		TERMIUS_MCP_PROXY: system.url,
		TERMIUS_MCP_PROXY_SOURCE: system.name,
		TERMIUS_MCP_NO_PROXY: [...systemNoProxy(env), ...LOOPBACK].join(","),
	};
}

/** One line for /termius status. */
export function describeProxy(settings: ProxySettings, env: NodeJS.ProcessEnv = process.env): string {
	if (settings.proxy === "off") return "direct (proxy off)";
	if (settings.proxy) {
		const bypass = settings.proxyBypass ? settings.proxyBypass.join(", ") || "nothing" : "loopback, private, link-local, *.local";
		return `${redactProxyUrl(settings.proxy)} (set with /termius proxy; bypass: ${bypass})`;
	}
	const system = systemProxy(env);
	if (!system) return "direct (no system proxy variables)";
	const noProxy = systemNoProxy(env);
	return `${redactProxyUrl(system.url)} (system ${system.name}${noProxy.length ? `; NO_PROXY ${noProxy.join(", ")}` : ""})`;
}
