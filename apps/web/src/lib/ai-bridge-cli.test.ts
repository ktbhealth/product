import { describe, expect, it } from "vitest";

import { PUBLISHED_AI_BRIDGE_CLI, resolveAiBridgeCli } from "./ai-bridge-cli.ts";

describe("resolveAiBridgeCli", () => {
	const cliPath = "/repo/packages/ai-bridge/src/cli.ts";

	it("prefers an explicit AI_BRIDGE_CLI override", () => {
		expect(resolveAiBridgeCli({ override: "ai-bridge", dev: true, cliPath })).toBe("ai-bridge");
		expect(resolveAiBridgeCli({ override: "bunx custom-pkg", cliPath })).toBe("bunx custom-pkg");
	});

	it("treats an empty override as unset", () => {
		expect(resolveAiBridgeCli({ override: "", dev: true, cliPath })).toBe(`bun ${cliPath}`);
	});

	it("emits the repo's cli.ts under bun in dev", () => {
		expect(resolveAiBridgeCli({ dev: true, cliPath })).toBe(`bun ${cliPath}`);
	});

	it("falls back to the published bunx package outside dev", () => {
		expect(resolveAiBridgeCli({ cliPath })).toBe(PUBLISHED_AI_BRIDGE_CLI);
		expect(resolveAiBridgeCli({ dev: false, cliPath })).toBe("bunx @ktb/ai-bridge");
	});
});
