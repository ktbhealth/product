import { describe, expect, it } from "vitest";

import * as mod from "./index.ts";

/** Barrel coverage — the package surface stays stable for consumers
 * (`@ktb/eval-adapter-local` re-exports it verbatim). */
describe("@ktb/ai-adapter-openai exports", () => {
	it("exposes the openai-compatible chat driver", () => {
		expect(typeof mod.makeChatLlm).toBe("function");
	});
});
