/**
 * What the footer shows for termius, published on globalThis like
 * idle-keepwarm's snapshot (extensions share one process, not module
 * instances).
 *
 * At rest it says something only when the setup differs from the default:
 * a global route other than "termius", or hosts with a session allow or a
 * temporary level. While a call connects it names the host. vibrant-footer
 * draws it as a compact segment in its stats line; pi's default footer gets
 * the same short text through setStatus("termius", ...), which
 * vibrant-footer skips.
 */

import type { RouteMode } from "./config.ts";

export interface TermiusFooterSnapshot {
	/** The global route, when it is not "termius". */
	route?: RouteMode;
	/** Hosts with a session allow or a temporary level. */
	grants: number;
	/** Label of the host a call is connecting to or running on. */
	active?: string;
	/** More calls running besides `active`. */
	moreActive: number;
}

export const TERMIUS_FOOTER_KEY = Symbol.for("pi-preset.termius.footer");
export const TERMIUS_STATUS_KEY = "termius";

export function publishFooter(snapshot: TermiusFooterSnapshot | undefined): void {
	(globalThis as Record<symbol, unknown>)[TERMIUS_FOOTER_KEY] = snapshot;
}

export function readFooter(): TermiusFooterSnapshot | undefined {
	return (globalThis as Record<symbol, unknown>)[TERMIUS_FOOTER_KEY] as TermiusFooterSnapshot | undefined;
}

/** True when there is nothing worth showing. */
export function footerIsEmpty(snapshot: TermiusFooterSnapshot | undefined): boolean {
	return !snapshot || (!snapshot.route && snapshot.grants === 0 && !snapshot.active);
}

/**
 * The segment text without the icon: the active host while a call runs,
 * otherwise the route and the grant count. `narrow` drops the route when
 * there is a count to show.
 */
export function footerText(snapshot: TermiusFooterSnapshot, routeName: (mode: RouteMode) => string, narrow = false): string {
	if (snapshot.active) return snapshot.moreActive > 0 ? `${snapshot.active} +${snapshot.moreActive}` : snapshot.active;
	const parts: string[] = [];
	if (snapshot.route && !(narrow && snapshot.grants > 0)) parts.push(routeName(snapshot.route));
	if (snapshot.grants > 0) parts.push(`+${snapshot.grants}`);
	return parts.join(" ");
}
