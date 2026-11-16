import { describe, expect, it } from "vitest";

import * as mod from "./index.ts";

/** Barrel coverage — the package surface stays stable for consumers
 * (`@ktb/eval-adapter-local` re-exports it verbatim). */
describe("@ktb/ai-adapter-acp exports", () => {
	it("exposes the http acp transport and the acp llm driver", () => {
		expect(typeof mod.makeHttpAcpTransport).toBe("function");
		expect(typeof mod.makeAcpLlm).toBe("function");
	});
});
