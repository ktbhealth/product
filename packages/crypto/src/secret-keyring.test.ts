import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { SecretKeyring, SecretKeyringError, type SecretKeyringService } from "./secret-keyring.ts";

describe("SecretKeyringError", () => {
	it("defaults the message from the reason", () => {
		const err = new SecretKeyringError("unavailable");
		expect(err.name).toBe("SecretKeyringError");
		expect(err.reason).toBe("unavailable");
		expect(err.message).toBe("secret keyring unavailable");
	});

	it("keeps a caller-provided message", () => {
		const err = new SecretKeyringError("malformed", "bad key material");
		expect(err.reason).toBe("malformed");
		expect(err.message).toBe("bad key material");
	});
});

describe("SecretKeyring port", () => {
	it("resolves as a Context service", async () => {
		const service: SecretKeyringService = {
			wrapDek: async (rawDek) => `wrapped:${rawDek.length}`,
			unwrapDek: async () => new Uint8Array(32),
			kekVersion: "test:kek",
		};
		const runtime = ManagedRuntime.make(Layer.succeed(SecretKeyring, SecretKeyring.of(service)));
		const wrapped = await runtime.runPromise(
			Effect.flatMap(SecretKeyring, (k) => Effect.promise(() => k.wrapDek(new Uint8Array(32)))),
		);
		expect(wrapped).toBe("wrapped:32");
		const version = await runtime.runPromise(Effect.map(SecretKeyring, (k) => k.kekVersion));
		expect(version).toBe("test:kek");
		await runtime.dispose();
	});
});
