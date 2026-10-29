/**
 * What the footer shows for the skill store: the number of skills enabled
 * for this session only, published on globalThis like termius's snapshot
 * (extensions share one process, not module instances). Nothing is shown
 * when that number is zero: project and always-on skills are steady state.
 */

export interface SkillsFooterSnapshot {
	/** Skills enabled at the session level. */
	session: number;
	/** Enabled through the tool and not yet reported to pi (shown after the next /reload). */
	pending: number;
}

export const SKILLS_FOOTER_KEY = Symbol.for("pi-preset.skills.footer");
export const SKILLS_STATUS_KEY = "skills";

export function publishSkillsFooter(snapshot: SkillsFooterSnapshot | undefined): void {
	(globalThis as Record<symbol, unknown>)[SKILLS_FOOTER_KEY] = snapshot;
}

export function readSkillsFooter(): SkillsFooterSnapshot | undefined {
	return (globalThis as Record<symbol, unknown>)[SKILLS_FOOTER_KEY] as SkillsFooterSnapshot | undefined;
}

export function skillsFooterText(snapshot: SkillsFooterSnapshot | undefined): string | undefined {
	if (!snapshot || snapshot.session === 0) return undefined;
	return snapshot.pending > 0 ? `${snapshot.session}*` : `${snapshot.session}`;
}
