import { describe, expect, it } from "vitest";
import {
	GLOBAL_SCOPE,
	indexMessages,
	localeChain,
	portalInstanceScope,
	portalScope,
	resolveMessage,
	resolveRequestLocales,
	tenantScope,
	type MessageRow,
} from "./resolve.ts";

const row = (over: Partial<MessageRow>): MessageRow => ({
	namespace: "app",
	key: "title",
	locale: "en",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Title",
	status: "published",
	params: [],
	version: 1,
	...over,
});

describe("resolveMessage", () => {
	it("hits global/en", () => {
		const idx = indexMessages([row({})]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: GLOBAL_SCOPE,
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("Title");
		expect(r.source.kind).toBe("hit");
	});

	it("prefers portal over tenant over global", () => {
		const idx = indexMessages([
			row({ value: "global" }),
			row({ scope: "tenant", scopeId: "t1", value: "tenant" }),
			row({ scope: "portal", scopeId: "p1", value: "portal" }),
		]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: portalScope("t1", "p1"),
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("portal");
	});

	it("portal-instance scope hits portal then global (no tenant slot)", () => {
		const idx = indexMessages([
			row({ value: "global" }),
			row({ scope: "portal", scopeId: "clinician", value: "portal" }),
			row({ scope: "tenant", scopeId: "t1", value: "tenant" }),
		]);
		const hit = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: portalInstanceScope("clinician"),
			locales: localeChain(["en"], "en"),
		});
		expect(hit.template).toBe("portal");
		// A different portal id skips both portal and tenant rows.
		const miss = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: portalInstanceScope("other"),
			locales: localeChain(["en"], "en"),
		});
		expect(miss.template).toBe("global");
	});

	it("falls back tenant→global when portal misses", () => {
		const idx = indexMessages([
			row({ value: "global" }),
			row({ scope: "tenant", scopeId: "t1", value: "tenant" }),
		]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: portalScope("t1", "p999"),
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("tenant");
	});

	it("locale chain falls back pt-BR→en", () => {
		const idx = indexMessages([
			row({ locale: "en", value: "English" }),
			row({ locale: "pt-BR", value: "Português" }),
		]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: GLOBAL_SCOPE,
			locales: localeChain(["pt-BR"], "en"),
		});
		expect(r.template).toBe("Português");
		const r2 = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: GLOBAL_SCOPE,
			locales: localeChain(["es"], "en"),
		});
		expect(r2.template).toBe("English");
	});

	it("returns namespace.key sentinel on total miss", () => {
		const idx = indexMessages([]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "nope",
			scopeChain: GLOBAL_SCOPE,
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("app.nope");
		expect(r.source).toEqual({ kind: "missing" });
	});

	it("ignores draft rows", () => {
		const idx = indexMessages([row({ status: "draft", value: "Draft" })]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: GLOBAL_SCOPE,
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("app.title");
	});

	it("tenant scope without tenant row falls to global", () => {
		const idx = indexMessages([row({ value: "global" })]);
		const r = resolveMessage(idx, {
			namespace: "app",
			key: "title",
			scopeChain: tenantScope("other-tenant"),
			locales: localeChain(["en"], "en"),
		});
		expect(r.template).toBe("global");
	});
});

describe("resolveRequestLocales", () => {
	const enabled = [
		{ code: "en", fallbacks: [] },
		{ code: "pt-BR", fallbacks: ["en"] },
		{ code: "es", fallbacks: ["en"] },
	];

	it("requested enabled locale wins with its fallback chain", () => {
		const l = resolveRequestLocales("pt-BR", enabled, "en");
		expect(l.locales).toEqual(["pt-BR", "en"]);
		expect(l.defaultLocale).toBe("en");
	});

	it("unknown/disabled requested locale falls to default", () => {
		expect(resolveRequestLocales("fr", enabled, "en").locales).toEqual(["en"]);
		expect(resolveRequestLocales(undefined, enabled, "en").locales).toEqual(["en"]);
	});

	it("dedupes when fallback equals requested", () => {
		const l = resolveRequestLocales("en", enabled, "en");
		expect(l.locales).toEqual(["en"]);
	});
});
