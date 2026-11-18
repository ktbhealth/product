import { describe, expect, it } from "vitest";

import type { EvalInstance, EvalInstanceItem } from "./schema.ts";
import { instanceToDatasetManifest } from "./manifest.ts";

const instance = (over: Partial<EvalInstance> = {}): EvalInstance => ({
	id: 4,
	name: "cohort",
	mode: "random",
	endpointId: 9,
	params: JSON.stringify({ seed: 7, count: 2 }),
	status: "ready",
	total: 2,
	done: 2,
	manifest: null,
	createdBy: "v@x.com",
	createdAt: new Date(1_700_000_000_000),
	...over,
});

const item = (id: number, script: string | null, status = "done"): EvalInstanceItem =>
	({
		id,
		instanceId: 4,
		personaDefId: null,
		persona: null,
		script,
		turns: null,
		voices: null,
		patientId: null,
		doctorId: null,
		scriptMode: "template",
		status,
		error: null,
		state: "under_review",
		feedback: null,
		reviewedBy: null,
		reviewedAt: null,
		claimedAt: null,
		createdAt: new Date(1_700_000_000_000),
	}) as EvalInstanceItem;

describe("instanceToDatasetManifest", () => {
	it("projects id/domain/generator/provenance from the instance", () => {
		const m = instanceToDatasetManifest(instance(), [item(1, "a"), item(2, "b")]);
		expect(m.id).toBe("eval-instance-4");
		expect(m.domain).toBe("eval.consultation");
		expect(m.generator).toEqual({
			mode: "random",
			params: { seed: 7, count: 2 },
			endpointId: 9,
		});
		expect(m.provenance).toEqual({ createdBy: "v@x.com" });
		expect(m.createdAt).toBe(1_700_000_000_000);
	});

	it("counts only done items and versions from content", () => {
		const items = [item(1, "a"), item(2, "b", "error"), item(3, null, "pending")];
		const m = instanceToDatasetManifest(instance(), items);
		expect(m.sampleCount).toBe(1);
		expect(m.version).toMatch(/^v1-[0-9a-f]{8}$/);
		expect(m.contentHash).toMatch(/^[0-9a-f]{8}$/);
	});

	it("contentHash is order-stable and script-sensitive", () => {
		const a = instanceToDatasetManifest(instance(), [item(1, "a"), item(2, "b")]);
		const b = instanceToDatasetManifest(instance(), [item(2, "b"), item(1, "a")]);
		const c = instanceToDatasetManifest(instance(), [item(1, "a"), item(2, "B")]);
		expect(a.contentHash).toBe(b.contentHash);
		expect(a.contentHash).not.toBe(c.contentHash);
		expect(a.version).toBe(b.version);
	});

	it("degrades malformed params JSON to {}", () => {
		const m = instanceToDatasetManifest(instance({ params: "{oops", endpointId: null }), []);
		expect(m.generator).toEqual({ mode: "random", params: {}, endpointId: null });
	});
});
