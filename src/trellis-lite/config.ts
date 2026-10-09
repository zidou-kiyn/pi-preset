/** trellis-lite switches, read from the environment (see extensions/trellis-lite.ts). */

export interface TrellisConfig {
	enabled: boolean;
	specInjection: boolean;
}

const isOff = (value: string | undefined) => /^(off|0|false|no)$/iu.test((value ?? "").trim());

export function readTrellisConfig(env: NodeJS.ProcessEnv): TrellisConfig {
	return {
		enabled: !isOff(env.PI_PRESET_TRELLIS),
		specInjection: !isOff(env.PI_PRESET_TRELLIS_SPECS),
	};
}
