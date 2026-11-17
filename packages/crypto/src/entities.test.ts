import { describe, expect, it } from "vitest";

import { CONSULTATION_ENTITY_TYPE } from "./entities.ts";

describe("entity type discriminators", () => {
	it("pins the consultation entity_type namespace", () => {
		// ZK key material: changing this orphans every entity_deks row
		// and grant written under the old name.
		expect(CONSULTATION_ENTITY_TYPE).toBe("consultation");
	});
});
