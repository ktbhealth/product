import { describe, expect, it } from "vitest";

import type { I18nMessage } from "../schema.ts";

import {
	buildCellIndex,
	cellFor,
	cellKey,
	isDraftDirty,
	summarizeImportPayload,
} from "./i18n-page-utils.ts";

const row = (over: Partial<I18nMessage>): I18nMessage => ({
	namespace: "app",
	key: "title",
	locale: "en",
	scope: "global",
	scopeId: "",
	kind: "text",
	value: "Hello",
	draftValue: null,
	status: "published",
	params: [],
	version: 1,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...over,
});

describe("cellKey / cellFor", () => {
	it("distinguishes every cell coordinate", () => {
		const a = cellKey("ns", "k", "en");
		expect(a).not.toBe(cellKey("ns", "k", "pt-BR"));
		expect(a).not.toBe(cellKey("ns", "k", "en", "tenant", "t1"));
		expect(cellKey("ns|x", "k", "en")).not.toBe(cellKey("ns", "x|k", "en"));
	});

	it("indexes rows once and looks cells up in O(1)", () => {
		const index = buildCellIndex([
			row({}),
			row({ locale: "pt-BR", value: "Olá", draftValue: "Oi" }),
			row({ key: "other", value: "Other" }),
			row({ scope: "tenant", scopeId: "t1", value: "Scoped" }),
		]);
		expect(cellFor(index, "app", "title", "en")).toEqual({
			draft: null,
			live: "Hello",
			status: "published",
			kind: "text",
		});
		expect(cellFor(index, "app", "title", "pt-BR")?.draft).toBe("Oi");
		expect(cellFor(index, "app", "title", "en", "tenant", "t1")?.live).toBe("Scoped");
		expect(cellFor(index, "app", "title", "en", "tenant", "t2")).toBeUndefined();
		expect(cellFor(index, "app", "missing", "en")).toBeUndefined();
	});
});

describe("isDraftDirty", () => {
	it("compares against draft, then live, then empty", () => {
		const withDraft = {
			draft: "staged",
			live: "live",
			status: "draft" as const,
			kind: "text" as const,
		};
		const liveOnly = {
			draft: null,
			live: "live",
			status: "published" as const,
			kind: "text" as const,
		};
		expect(isDraftDirty("staged", withDraft)).toBe(false);
		expect(isDraftDirty("edited", withDraft)).toBe(true);
		expect(isDraftDirty("live", liveOnly)).toBe(false);
		expect(isDraftDirty("", undefined)).toBe(false);
		expect(isDraftDirty("x", undefined)).toBe(true);
	});
});

describe("summarizeImportPayload", () => {
	it("rejects non-objects and missing fields", () => {
		expect(summarizeImportPayload(null)).toEqual({ ok: false, error: "not an i18n export file" });
		expect(summarizeImportPayload("x")).toEqual({ ok: false, error: "not an i18n export file" });
		expect(summarizeImportPayload({ messages: {} })).toEqual({
			ok: false,
			error: "missing namespace",
		});
		expect(summarizeImportPayload({ namespace: "", messages: {} })).toEqual({
			ok: false,
			error: "missing namespace",
		});
		expect(summarizeImportPayload({ namespace: "app" })).toEqual({
			ok: false,
			error: "missing messages",
		});
		expect(summarizeImportPayload({ namespace: "app", messages: null })).toEqual({
			ok: false,
			error: "missing messages",
		});
	});

	it("counts locales, distinct keys and entries", () => {
		const res = summarizeImportPayload({
			version: 1,
			namespace: "app",
			messages: {
				en: { title: "Hello", bye: "Bye" },
				"pt-BR": { title: "Olá" },
				broken: "not-an-object",
			},
		});
		expect(res).toEqual({
			ok: true,
			summary: { namespace: "app", localeCount: 3, keyCount: 2, entryCount: 3 },
		});
	});
});
