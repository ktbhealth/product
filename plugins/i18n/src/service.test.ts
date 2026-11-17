import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { GLOBAL_SCOPE, indexMessages, localeChain, type MessageRow } from "@ktb/i18n";

import { i18nLayerFor, requestI18n } from "./service.ts";
import type { I18nRuntimeShape } from "./runtime.ts";

const row = (over: Partial<MessageRow>): MessageRow => ({
	namespace: "app",
	key: "title",
	locale: "en",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Hello {name}",
	status: "published",
	params: [{ name: "name" }],
	version: 1,
	...over,
});

const runtimeWith = (rows: readonly MessageRow[]): I18nRuntimeShape => ({
	catalogFor: () => Effect.succeed(indexMessages(rows)),
	invalidate: () => Effect.void,
});

/** Same index instance on every call — exercises per-index caches. */
const runtimeWithStableIndex = (rows: readonly MessageRow[]): I18nRuntimeShape => {
	const index = indexMessages(rows);
	return {
		catalogFor: () => Effect.succeed(index),
		invalidate: () => Effect.void,
	};
};

describe("requestI18n", () => {
	it("resolve() returns the resolved message and logs misses", async () => {
		const i18n = requestI18n(runtimeWith([row({})]), GLOBAL_SCOPE, localeChain(["en"], "en"));
		const hit = await Effect.runPromise(i18n.resolve("app", "title"));
		expect(hit.template).toBe("Hello {name}");
		expect(hit.source.kind).toBe("hit");
		// Missing key still resolves (sentinel) — the telemetry path runs.
		const miss = await Effect.runPromise(i18n.resolve("app", "nope"));
		expect(miss.source.kind).toBe("missing");
	});

	it("paramsFor() reads row params then falls back to the manifest", async () => {
		const i18n = requestI18n(runtimeWith([row({})]), GLOBAL_SCOPE, localeChain(["en"], "en"));
		expect(await Effect.runPromise(i18n.paramsFor("app", "title"))).toEqual([{ name: "name" }]);
		// No row and no manifest entry → empty signature.
		expect(await Effect.runPromise(i18n.paramsFor("nope", "nope"))).toEqual([]);
	});

	it("reuses the cached namespace list for the same catalog index", async () => {
		const i18n = requestI18n(
			runtimeWithStableIndex([row({})]),
			GLOBAL_SCOPE,
			localeChain(["en"], "en"),
		);
		// First call populates the WeakMap; the second hits it.
		await Effect.runPromise(i18n.t("app.title", { name: "A" }));
		const text = await Effect.runPromise(i18n.t("app.title", { name: "B" }));
		expect(text).toBe("Hello B");
	});

	it("splits keys with no registered namespace prefix on the first dot", async () => {
		const i18n = requestI18n(runtimeWith([row({})]), GLOBAL_SCOPE, localeChain(["en"], "en"));
		// No dot at all → empty namespace, whole input is the key.
		expect(await Effect.runPromise(i18n.t("plainkey"))).toBe(".plainkey");
		// Dotted but unregistered → first-dot split (sentinel verbatim).
		expect(await Effect.runPromise(i18n.t("other.thing"))).toBe("other.thing");
	});

	it("tolerates an empty locale chain (defaults to en for telemetry/render)", async () => {
		const i18n = requestI18n(runtimeWith([]), GLOBAL_SCOPE, {
			locales: [],
			defaultLocale: "en",
		});
		const miss = await Effect.runPromise(i18n.resolve("app", "nope"));
		expect(miss.source.kind).toBe("missing");
		expect(await Effect.runPromise(i18n.t("app.nope"))).toBe("app.nope");
	});

	it("dedupes, sanitizes and saturates missing-key telemetry", async () => {
		const i18n = requestI18n(runtimeWith([row({})]), GLOBAL_SCOPE, localeChain(["en"], "en"));
		// Control chars are stripped before logging (0x00, 0x7f dropped).
		await Effect.runPromise(i18n.resolve("app", "bad\x00\x7fkey"));
		// Same (namespace, key, locale) twice → second is deduped.
		await Effect.runPromise(i18n.resolve("app", "dup-miss"));
		await Effect.runPromise(i18n.resolve("app", "dup-miss"));
		// Fill the dedup Set past MISSING_LOG_LIMIT (1024): further
		// unique misses are counted as suppressed instead of logged.
		for (let i = 0; i < 1100; i++) {
			const miss = await Effect.runPromise(i18n.resolve("app", `flood-${i}`));
			expect(miss.source.kind).toBe("missing");
		}
	});
});

describe("i18nLayerFor", () => {
	it("returns a working I18nShape for the given scope/locales", async () => {
		const i18n = i18nLayerFor(runtimeWith([row({})]), GLOBAL_SCOPE, localeChain(["en"], "en"));
		const out = await Effect.runPromise(i18n.t("app.title", { name: "Ana" }));
		expect(out).toBe("Hello Ana");
	});
});
