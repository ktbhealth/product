import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("verify-email client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries only client-consumed page fields", () => {
		const page = plugins[0]?.pages?.[0];
		expect(page?.id).toBe("verify-email.page");
		expect(page?.path).toBe("/verify-email");
		expect(page?.context).toBe("app");
		// loader/guard are server-only Effects — they must never reach
		// the client bundle.
		expect(page?.loader).toBeUndefined();
		expect(page?.guard).toBeUndefined();
	});
});
