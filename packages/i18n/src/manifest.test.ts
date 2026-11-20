import { describe, expect, it } from "vitest";

import { I18N_MANIFEST } from "./manifest.gen.ts";
import { i18nManifestHash } from "./manifest.ts";

describe("i18nManifestHash", () => {
	it("is deterministic — same namespace hashes identically across calls", () => {
		expect(i18nManifestHash("app")).toBe(i18nManifestHash("app"));
		expect(i18nManifestHash("patients")).toBe(i18nManifestHash("patients"));
	});

	it("returns an 8-char lowercase hex digest", () => {
		for (const ns of Object.keys(I18N_MANIFEST)) {
			expect(i18nManifestHash(ns)).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	it("differs across namespaces with different contracts", () => {
		const hashes = new Set(Object.keys(I18N_MANIFEST).map((ns) => i18nManifestHash(ns)));
		// Sanity: the fixture manifest is large enough that a hash
		// function collapsing everything to one digest would be caught.
		expect(hashes.size).toBeGreaterThan(1);
		expect(i18nManifestHash("app")).not.toBe(i18nManifestHash("agenda"));
	});

	it("returns null for namespaces absent from the manifest", () => {
		expect(i18nManifestHash("cov.orphan")).toBeNull();
		expect(i18nManifestHash("")).toBeNull();
		expect(i18nManifestHash("not.a.namespace")).toBeNull();
	});

	it("matches an independently computed FNV-1a hash of the canonical contract", () => {
		// Recompute the documented canonical form + FNV-1a independently:
		// sorted keys → [key, sorted param names], JSON, FNV-1a 32-bit.
		const fnv1a = (input: string): string => {
			let h = 0x811c9dc5;
			for (let i = 0; i < input.length; i++) {
				h ^= input.charCodeAt(i);
				h = Math.imul(h, 0x01000193);
			}
			return (h >>> 0).toString(16).padStart(8, "0");
		};
		type Entry = Record<string, { params: readonly { name: string }[] }>;
		for (const [ns, entry] of Object.entries(I18N_MANIFEST as Record<string, Entry>)) {
			const canonical = Object.keys(entry)
				.sort()
				.map((key) => [key, entry[key]!.params.map((p) => p.name).sort()]);
			expect(i18nManifestHash(ns), ns).toBe(fnv1a(JSON.stringify(canonical)));
		}
	});
});
