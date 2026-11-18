import { describe, expect, it } from "vitest";

import { SecretKeyring, SecretKeyringError } from "./secret-keyring.ts";

describe("SecretKeyringError", () => {
	it("defaults the message from the reason", () => {
		for (const reason of ["unavailable", "malformed", "decrypt-failed"] as const) {
			const err = new SecretKeyringError(reason);
			expect(err.reason).toBe(reason);
			expect(err.message).toBe(`secret keyring ${reason}`);
			expect(err.name).toBe("SecretKeyringError");
		}
	});

	it("accepts a custom message", () => {
		const err = new SecretKeyringError("malformed", "bad kek material");
		expect(err.message).toBe("bad kek material");
		expect(err.reason).toBe("malformed");
	});
});

describe("SecretKeyring port", () => {
	it("is a Context service tag", () => {
		expect(SecretKeyring.key).toBe("@ktb/crypto/SecretKeyring");
	});
});
