import { describe, expect, it, vi } from "vitest";

import type { AnamnesisExtractor } from "@ktb/anamnesis";
import { makeKeyring, memorySecretStore, memoryStore } from "@ktb/crypto/keyring";
import { saveByokConfig } from "@ktb/vault/byok";

import { resolveByokExtractor } from "./byok.ts";

const keyring = () => makeKeyring({ store: memoryStore(), secrets: memorySecretStore() });

const make = (name: string) =>
	vi.fn((): AnamnesisExtractor => ({
		name,
		extract: async () => {
			throw new Error("unused");
		},
	}));

describe("resolveByokExtractor (T-146)", () => {
	it("is null without a sealed provider key — factory not called", async () => {
		const factory = make("stub");
		expect(await resolveByokExtractor(keyring(), factory)).toBeNull();
		expect(factory).not.toHaveBeenCalled();
	});

	it("builds the extractor from the sealed config through the injected factory", async () => {
		const k = keyring();
		await saveByokConfig(k, { apiKey: "sk-1", model: "m", baseUrl: "https://llm.x/v1" });
		const factory = make("byok");
		const extractor = await resolveByokExtractor(k, factory);
		expect(extractor?.name).toBe("byok");
		expect(factory).toHaveBeenCalledWith({
			apiKey: "sk-1",
			model: "m",
			baseUrl: "https://llm.x/v1",
		});
	});
});
