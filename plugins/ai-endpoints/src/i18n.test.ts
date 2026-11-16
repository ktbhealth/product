import { describe, expect, it } from "vitest";

import { AI_ENDPOINT_LOCALES, aiEndpointMessages } from "./i18n.ts";

describe("aiEndpointMessages", () => {
	it("returns a catalog for every locale", () => {
		for (const locale of AI_ENDPOINT_LOCALES) {
			const m = aiEndpointMessages(locale);
			expect(m.endpointsTitle.length).toBeGreaterThan(0);
			expect(m.newEndpoint.length).toBeGreaterThan(0);
			expect(m.test.length).toBeGreaterThan(0);
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(aiEndpointMessages("fr")).toBe(aiEndpointMessages("en"));
	});
});
