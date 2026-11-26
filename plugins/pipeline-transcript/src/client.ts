import { clientStub, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The `pipelines` pack carries stage
 * implementations (Effects over eval ports) — server-manifest data
 * that must never ride the client bundle — so it degrades to a
 * bare-id marker, the same convention tables/services follow. Keep ids
 * and dep edges in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	clientStub({
		id: "pipeline.transcript",
		meta: {
			name: "Transcript pipeline",
			description:
				"Consultation transcript cleanup pipeline — ASR-error gating plus platform-endpoint LLM correction, shared by production surfaces and eval drivers.",
			keywords: ["transcription", "services"],
		},
	}),
];
