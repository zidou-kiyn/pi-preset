/** Shared display helpers for /termius screens, the approval dialog, and the footer. */

import { redactProxyUrl } from "./proxy.ts";
import type { RouteInfo } from "./host-index.ts";
import { type Messages, messages } from "./messages.ts";

/** "3 min ago" for an ISO time; the raw text when it does not parse. */
export function ago(value: unknown, now = Date.now(), m: Messages = messages()): string {
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(time)) return String(value || m.never);
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return m.justNow;
	if (seconds < 3600) return m.minutesAgo(Math.round(seconds / 60));
	if (seconds < 86400) return m.hoursAgo(Math.round(seconds / 3600));
	return m.daysAgo(Math.round(seconds / 86400));
}

/** The proxy part of a server route description, without the "(source)" suffix. */
function proxyName(proxy: string): string {
	return redactProxyUrl(proxy.replace(/\s+\(.*\)$/u, ""));
}

/** How a host is reached, in full: "bastion → gw", "proxy socks5://… → bastion", "direct". */
export function routeSummary(route: RouteInfo, m: Messages = messages()): string {
	const hops = route.jump_hosts.join(" → ");
	const proxy = route.proxy ? `${m.routeColumnProxy} ${proxyName(route.proxy)}` : "";
	let text: string;
	if (route.error) text = `${m.routeName(route.mode)} (${m.routeColumnError})`;
	else if (hops) text = proxy ? `${proxy} → ${hops}` : hops;
	else text = proxy || m.routeColumnDirect;
	return text;
}

/** The short form for the host list column: "→bastion", "⇢bastion" (first hop via proxy), "direct", "proxy". */
export function routeColumn(route: RouteInfo, m: Messages = messages()): string {
	if (route.error) return m.routeColumnError;
	if (route.jump_hosts.length > 0) return `${route.proxy ? "⇢" : "→"}${route.jump_hosts.join("→")}`;
	return route.proxy ? m.routeColumnProxy : m.routeColumnDirect;
}

/** Joined server route stages ("proxy socks5://… (ALL_PROXY)", "jump host a (1.2.3.4)"), for the activity log. */
export function routeStages(stages: unknown): string | undefined {
	if (!Array.isArray(stages)) return undefined;
	const text = stages.map(String).join(" → ");
	return text || undefined;
}

/** A stage's `via` from the connection test ("direct", "proxy URL (source)", "jump host a"), shortened. */
export function viaText(via: string, m: Messages = messages()): string {
	if (via === "direct") return m.routeColumnDirect;
	const jump = /^jump host (.+)$/u.exec(via);
	if (jump) return jump[1]!;
	const proxy = /^proxy (\S+)/u.exec(via);
	return proxy ? `${m.routeColumnProxy} ${redactProxyUrl(proxy[1]!)}` : via;
}

/** A logged route (joined server stages) in short form: "proxy → bastion", "direct". */
export function shortRoute(route: string | undefined, m: Messages = messages()): string {
	if (!route || route === "direct") return m.routeColumnDirect;
	return route
		.split(" → ")
		.map((stage) => {
			const jump = /^jump host (.+?) \(/u.exec(stage);
			if (jump) return jump[1]!;
			return stage.startsWith("proxy ") ? m.routeColumnProxy : stage;
		})
		.join(" → ");
}
