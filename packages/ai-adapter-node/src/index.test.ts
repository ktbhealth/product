import { describe, expect, it } from "vitest";

import * as mod from "./index.ts";

/** Barrel coverage — the package surface stays stable for consumers
 * (`@ktb/eval-adapter-local` re-exports it verbatim). */
describe("@ktb/ai-adapter-node exports", () => {
	it("exposes the stdio transport, acp client and node llm driver", () => {
		expect(typeof mod.makeStdioRpc).toBe("function");
		expect(typeof mod.openAcpSession).toBe("function");
		expect(typeof mod.makeNodeAcpLlm).toBe("function");
		expect(typeof mod.resolveNodeAcp).toBe("function");
	});
});
