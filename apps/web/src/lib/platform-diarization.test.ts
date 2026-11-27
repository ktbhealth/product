import { describe, expect, it, vi } from "vitest";

// platform.ts resolves the diarization backend once at module scope from
// AUDIO_DIARIZATION / AUDIO_DIARIZATION_URL — same recompose pattern as
// platform-jobs.test.ts.

const compose = async (configure: (env: Record<string, unknown>) => void) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	return import("./platform.ts");
};

describe("platform audio diarization wiring (P-118)", () => {
	it("builds a dedicated local AI when flag and URL are set", { timeout: 30_000 }, async () => {
		const platform = await compose((env) => {
			env.AUDIO_DIARIZATION = "1";
			env.AUDIO_DIARIZATION_URL = "http://diarize.local:9000";
		});
		expect(platform.audioDiarization).toBe(true);
		expect(platform.audioDiarizationAi).toBeDefined();
	});

	it("leaves the dedicated AI undefined when only the flag is set", async () => {
		const platform = await compose((env) => {
			env.AUDIO_DIARIZATION = "1";
			env.AUDIO_DIARIZATION_URL = undefined;
		});
		expect(platform.audioDiarization).toBe(true);
		expect(platform.audioDiarizationAi).toBeUndefined();
	});
});
