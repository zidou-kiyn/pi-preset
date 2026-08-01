import { type JsonObject, writeJsonObjectAtomic } from "./json-merge.ts";
import {
	getModelsProviders,
	type ModelsDocument,
	type ReadyProviderPlan,
	readModelsDocument,
	semanticJsonEqual,
} from "./models-config.ts";

export interface ApplyModelsProviderResult {
	changed: boolean;
	targetPath: string;
	backupPath?: string;
}

function hasOwn(source: JsonObject, key: string): boolean {
	return Object.hasOwn(source, key);
}

function targetProviderChanged(plan: ReadyProviderPlan, latest: ModelsDocument): boolean {
	if (plan.baselineTargetPath !== undefined && latest.targetPath !== plan.baselineTargetPath) return true;

	const providers = getModelsProviders(latest.data);
	const latestExists = hasOwn(providers, plan.providerId);
	if (latestExists !== plan.baselineProviderExists) return true;
	if (!latestExists) return false;
	return !semanticJsonEqual(providers[plan.providerId], plan.existingProvider);
}

/** Re-read and atomically apply one provider object without merging stale fields. */
export function applyProviderPlan(plan: ReadyProviderPlan, inputPath: string): ApplyModelsProviderResult {
	if (plan.status === "already-configured") {
		return { changed: false, targetPath: plan.baselineTargetPath ?? inputPath };
	}

	const latest = readModelsDocument(inputPath);
	if (targetProviderChanged(plan, latest)) {
		throw new Error(`provider "${plan.providerId}" changed after preview; run /preset-models-add again`);
	}

	const latestProviders = getModelsProviders(latest.data);
	const updatedProviders: JsonObject = { ...latestProviders, [plan.providerId]: plan.candidate };
	const updatedDocument: JsonObject = { ...latest.data, providers: updatedProviders };

	writeJsonObjectAtomic(inputPath, updatedDocument, {
		newFileMode: 0o600,
		rejectDanglingSymlink: true,
	});

	return {
		changed: true,
		targetPath: latest.targetPath,
		backupPath: latest.exists ? `${latest.targetPath}.preset-bak` : undefined,
	};
}
