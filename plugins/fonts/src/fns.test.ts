import { describe, expect, it, vi } from "vitest";

import type * as Effect from "effect/Effect";

import { reactStartMock } from "@ktb/server-fns/testing";

import type { FontFamilySummary, FontProviderSummary } from "./types.ts";

/**
 * Server-fn wiring test: the react-start chain and the
 * @ktb/server-fns session/run boundary are stubbed; the Fonts service
 * is an inline recording stub so each fn's decode + delegation is
 * asserted without a runtime.
 */
vi.mock("@tanstack/react-start", () => reactStartMock());

const calls: { method: string; args: unknown[] }[] = [];
const provider: FontProviderSummary = {
	id: 1,
	kind: "googlefonts",
	name: "Google Fonts",
	config: null,
	enabled: true,
	familyCount: 0,
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: null,
};
const family: FontFamilySummary = {
	id: 2,
	providerId: 1,
	family: "Inter",
	weights: [400, 700],
	status: "ready",
	meta: null,
};

vi.mock("@ktb/server-fns", async () => {
	const Effect = await import("effect/Effect");
	const { Fonts } = await import("./service.ts");

	const fontsStub = Fonts.of({
		listProviders: () =>
			Effect.sync(() => {
				calls.push({ method: "listProviders", args: [] });
				return [provider];
			}),
		providerKinds: () => Effect.succeed(["googlefonts", "local"]),
		createProvider: (input) =>
			Effect.sync(() => {
				calls.push({ method: "createProvider", args: [input] });
				return provider;
			}),
		updateProvider: (id, patch) =>
			Effect.sync(() => {
				calls.push({ method: "updateProvider", args: [id, patch] });
				return provider;
			}),
		setProviderEnabled: (id, enabled) =>
			Effect.sync(() => {
				calls.push({ method: "setProviderEnabled", args: [id, enabled] });
			}),
		removeProvider: (id) =>
			Effect.sync(() => {
				calls.push({ method: "removeProvider", args: [id] });
			}),
		listFamilies: (providerId) =>
			Effect.sync(() => {
				calls.push({ method: "listFamilies", args: [providerId] });
				return [family];
			}),
		syncProvider: (id) =>
			Effect.sync(() => {
				calls.push({ method: "syncProvider", args: [id] });
				return [family];
			}),
	});

	const provide = <A, E>(effect: Effect.Effect<A, E, never>) =>
		effect.pipe(Effect.provideService(Fonts, fontsStub));

	return {
		runAs: (_user: unknown, effect: Effect.Effect<unknown, unknown, never>) =>
			Effect.runPromise(provide(effect)),
		ensureSessionUser: async () => ({ id: "u-admin", email: "admin@x.com" }),
		// Unused by this module but exported for parity with the real barrel.
		run: (effect: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(provide(effect)),
	};
});

import {
	createFontProviderFn,
	listFontFamiliesFn,
	listFontProviderKindsFn,
	listFontProvidersFn,
	removeFontProviderFn,
	setFontProviderEnabledFn,
	syncFontProviderFn,
	updateFontProviderFn,
} from "./fns.ts";

describe("fonts server fns", () => {
	it("listFontProvidersFn delegates to the service", async () => {
		const result = await listFontProvidersFn();
		expect(result).toEqual([provider]);
	});

	it("listFontProviderKindsFn returns registered kinds", async () => {
		const result = await listFontProviderKindsFn();
		expect(result).toEqual(["googlefonts", "local"]);
	});

	it("createFontProviderFn decodes and delegates", async () => {
		const result = await createFontProviderFn({
			data: { kind: "googlefonts", name: "Google Fonts" },
		});
		expect(result).toEqual(provider);
		expect(calls.at(-1)).toEqual({
			method: "createProvider",
			args: [{ kind: "googlefonts", name: "Google Fonts", config: undefined }],
		});
	});

	it("updateFontProviderFn passes id + patch through", async () => {
		await updateFontProviderFn({ data: { id: 3, name: "Renamed" } });
		expect(calls.at(-1)).toEqual({
			method: "updateProvider",
			args: [3, { name: "Renamed" }],
		});
	});

	it("setFontProviderEnabledFn posts id + enabled", async () => {
		const result = await setFontProviderEnabledFn({ data: { id: 3, enabled: false } });
		expect(result).toEqual({ ok: true });
		expect(calls.at(-1)).toEqual({ method: "setProviderEnabled", args: [3, false] });
	});

	it("removeFontProviderFn deletes by id", async () => {
		const result = await removeFontProviderFn({ data: { id: 3 } });
		expect(result).toEqual({ ok: true });
		expect(calls.at(-1)).toEqual({ method: "removeProvider", args: [3] });
	});

	it("listFontFamiliesFn forwards the optional providerId", async () => {
		const result = await listFontFamiliesFn({ data: { providerId: 7 } });
		expect(result).toEqual([family]);
		expect(calls.at(-1)).toEqual({ method: "listFamilies", args: [7] });
	});

	it("syncFontProviderFn returns the synced families", async () => {
		const result = await syncFontProviderFn({ data: { id: 3 } });
		expect(result).toEqual([family]);
		expect(calls.at(-1)).toEqual({ method: "syncProvider", args: [3] });
	});
});
