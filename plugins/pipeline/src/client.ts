import { clientStub, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The manifest is data-only (no
 * tables/services/contributions the browser consumes), so it
 * degenerates to a bare-id marker — the same convention the eval
 * capability packs follow. Keep ids and dep edges in sync — parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	clientStub({
		id: "pipeline.core",
		meta: {
			name: "Pipeline",
			description:
				"Pipeline engine composition — collects pipeline packs contributed by plugin manifests into the shared PipelineRegistry.",
			keywords: ["platform", "services"],
		},
	}),
];
