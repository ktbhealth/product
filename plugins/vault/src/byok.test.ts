import { describe, expect, it } from "vitest";

import { makeKeyring, memorySecretStore, memoryStore } from "@ktb/crypto/keyring";

import { BYOK_SECRET_NAME, clearByokConfig, loadByokConfig, saveByokConfig } from "./byok.ts";

const keyring = () => makeKeyring({ store: memoryStore(), secrets: memorySecretStore() });

describe("byok config store (T-146)", () => {
	it("round-trips a sealed provider key on this device", async () => {
		const k = keyring();
		expect(await loadByokConfig(k)).toBeNull();
		await saveByokConfig(k, {
			apiKey: "sk-clinic-1",
			model: "gpt-4o-mini",
			baseUrl: "https://llm.clinic.example/v1",
		});
		expect(await loadByokConfig(k)).toEqual({
			apiKey: "sk-clinic-1",
			model: "gpt-4o-mini",
			baseUrl: "https://llm.clinic.example/v1",
		});
	});

	it("omits baseUrl when not configured and replaces on save", async () => {
		const k = keyring();
		await saveByokConfig(k, { apiKey: "a", model: "m" });
		expect(await loadByokConfig(k)).toEqual({ apiKey: "a", model: "m" });
		await saveByokConfig(k, { apiKey: "b", model: "n" });
		expect(await loadByokConfig(k)).toEqual({ apiKey: "b", model: "n" });
	});

	it("returns null on stored drift instead of handing back a bad config", async () => {
		const k = keyring();
		await k.putSecret(BYOK_SECRET_NAME, "not json");
		expect(await loadByokConfig(k)).toBeNull();
		await k.putSecret(BYOK_SECRET_NAME, JSON.stringify({ apiKey: "", model: "m" }));
		expect(await loadByokConfig(k)).toBeNull();
		await k.putSecret(BYOK_SECRET_NAME, JSON.stringify({ apiKey: "k", model: 1 }));
		expect(await loadByokConfig(k)).toBeNull();
		await k.putSecret(BYOK_SECRET_NAME, JSON.stringify({ apiKey: "k", model: "m", baseUrl: 3 }));
		expect(await loadByokConfig(k)).toBeNull();
	});

	it("clears the stored config", async () => {
		const k = keyring();
		await saveByokConfig(k, { apiKey: "k", model: "m" });
		await clearByokConfig(k);
		expect(await loadByokConfig(k)).toBeNull();
	});
});
