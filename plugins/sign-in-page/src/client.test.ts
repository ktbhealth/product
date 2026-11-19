import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("sign-in-page client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries only client-consumed page fields", () => {
		const [picker, patient] = plugins[0]?.pages ?? [];
		expect(picker?.id).toBe("sign-in-page.picker");
		expect(picker?.path).toBe("/login");
		expect(picker?.context).toBe("app");
		expect(patient?.id).toBe("sign-in-page.patient");
		expect(patient?.path).toBe("/login/patient");
		expect(patient?.context).toBe("app");
		// loader/guard are server-only Effects — they must never reach
		// the client bundle.
		for (const page of plugins[0]?.pages ?? []) {
			expect(page.loader).toBeUndefined();
			expect(page.guard).toBeUndefined();
		}
	});
});
