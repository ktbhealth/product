import { describe, expect, it } from "vitest";

import { DecisionsPort, EvalPort } from "@ktb/eval-core";
import { AsrPort, LlmPort, PlatformDecisions, PlatformLlm } from "@ktb/eval-consultation";
import {
	AmbientAsrPort,
	AmbientDecisionsPort,
	AmbientLlmPort,
	AmbientPlatformDecisions,
	AmbientPlatformLlm,
} from "@ktb/orchestrator";

/**
 * Drift guard for the ambient port probes in
 * `packages/orchestrator/src/kinds.ts`. The orchestrator cannot import
 * the eval packages (they pull better-sqlite3 and would couple it to
 * the eval domain — it runs plugin-free in workerd and jobs-worker),
 * so its `ai` kind declares structural mirrors keyed by the SAME
 * Context tag strings. Effect keys services by tag `key`, so a rename
 * on either side silently degrades `ai` nodes to
 * `{skipped: true, reason: "no-port"}`. This package already depends
 * on both sides, so it is the natural home for the identity check.
 */
describe("ambient port keys", () => {
	it("AmbientLlmPort matches the canonical LlmPort tag", () => {
		expect(AmbientLlmPort.key).toBe(LlmPort.key);
	});

	it("AmbientDecisionsPort matches the canonical DecisionsPort/EvalPort tag", () => {
		expect(AmbientDecisionsPort.key).toBe(DecisionsPort.key);
		// `EvalPort` is a back-compat alias of `DecisionsPort` — same
		// class object, same key. Assert both names resolve identically
		// so the ambient mirror stays pinned to either spelling.
		expect(AmbientDecisionsPort.key).toBe(EvalPort.key);
	});

	it("AmbientAsrPort matches the canonical AsrPort tag", () => {
		expect(AmbientAsrPort.key).toBe(AsrPort.key);
	});

	it("AmbientPlatformLlm matches the canonical PlatformLlm tag", () => {
		expect(AmbientPlatformLlm.key).toBe(PlatformLlm.key);
	});

	it("AmbientPlatformDecisions matches the canonical PlatformDecisions tag", () => {
		expect(AmbientPlatformDecisions.key).toBe(PlatformDecisions.key);
	});
});
