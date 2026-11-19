import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { Forbidden, Principal, requirePrincipalUser } from "./index.ts";

describe("Principal", () => {
	it("is registered under its package-scoped key", () => {
		expect(Principal.key).toBe("@ktb/authz/Principal");
	});

	it("defaults to null outside a request context", async () => {
		await expect(Effect.runPromise(Effect.service(Principal))).resolves.toBeNull();
	});

	it("resolves the bound userId", async () => {
		await expect(
			Effect.runPromise(
				Effect.provideService(Effect.service(Principal), Principal, { userId: "u9" }),
			),
		).resolves.toEqual({ userId: "u9" });
	});
});

describe("Forbidden", () => {
	it("is a tagged error carrying the path", () => {
		const err = new Forbidden({ path: "patient.read" });
		expect(err._tag).toBe("Forbidden");
		expect(err.path).toBe("patient.read");
		expect(err).toBeInstanceOf(Forbidden);
	});
});

describe("requirePrincipalUser", () => {
	it("passes when principal matches", async () => {
		await expect(
			Effect.runPromise(
				Effect.provideService(requirePrincipalUser("u1", "patient.create"), Principal, {
					userId: "u1",
				}),
			),
		).resolves.toBeUndefined();
	});

	it("fails Forbidden on mismatch, null principal, or default path", async () => {
		const mismatch = Effect.provideService(
			requirePrincipalUser("u2", "patient.create"),
			Principal,
			{ userId: "u1" },
		);
		await expect(Effect.runPromise(mismatch)).rejects.toMatchObject({
			path: "patient.create",
		});
		await expect(Effect.runPromise(requirePrincipalUser("u1"))).rejects.toMatchObject({
			path: "principal",
		});
		await expect(
			Effect.runPromise(
				Effect.provideService(requirePrincipalUser("u2"), Principal, { userId: "u1" }),
			),
		).rejects.toMatchObject({ path: "principal" });
	});
});
