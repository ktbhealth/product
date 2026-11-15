import { describe, expect, it } from "vitest";

import { Accounts } from "./index.ts";

describe("Accounts port", () => {
	it("declares a stable service key", () => {
		expect(Accounts.key).toBe("@ktb/auth/Accounts");
	});
});
