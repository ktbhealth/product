import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			"apps/web",
			"apps/eval",
			"evals/*/vitest.config.ts",
			"packages/*",
			"plugins/*",
			"infra/*",
		],
		coverage: {
			provider: "v8",
			enabled: true,
			reporter: ["text", "html"],
			include: [
				"apps/web/src/**",
				"apps/eval/src/**",
				"evals/*/src/**",
				"packages/*/src/**",
				"plugins/*/src/**",
			],
			exclude: [
				// infra/* are standalone workers/scripts (ci-hook, ports,
				// lgtm, oci, cloudflare) — not application code. They keep
				// running their own tests via the projects glob above but are
				// out of the 100% app-code coverage measurement.
				"infra/**",
				"**/*.test.*",
				"**/*.d.ts",
				"**/routeTree.gen.ts",
				"**/schema.gen.ts",
				"**/worker-configuration.d.ts",
				"**/generated/**",
			],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
});
