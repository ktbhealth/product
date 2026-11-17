import { describe, expect, it } from "vitest";

import { createCatalogT, flattenCatalog, sliceMessages } from "./catalog.ts";
import { isParametrizedMessage, paramMessage } from "./message.ts";

describe("createCatalogT", () => {
	const t = createCatalogT(
		{
			"app.title": "Hello {name}",
			"app.items": "{count, plural, one {# item} other {# items}}",
		},
		"en",
	);

	it("renders params", () => {
		expect(t("app.title", { name: "Ana" })).toBe("Hello Ana");
	});

	it("renders plurals via Intl.PluralRules", () => {
		expect(t("app.items", { count: 1 })).toBe("1 item");
		expect(t("app.items", { count: 3 })).toBe("3 items");
	});

	it("missing key renders the namespace.key literal", () => {
		expect(t("app.missing")).toBe("app.missing");
	});
});

describe("flattenCatalog", () => {
	it("flattens nested objects to dot paths, keeps functions as leaves", () => {
		const flat = flattenCatalog({
			label: "Hi",
			sections: { identification: "ID", nested: { deep: "D" } },
			count: (n: number) => `${n}`,
			list: ["a", "b"],
		});
		expect(flat).toEqual([
			{ path: "label", value: "Hi" },
			{ path: "sections.identification", value: "ID" },
			{ path: "sections.nested.deep", value: "D" },
			{ path: "count", value: expect.any(Function) },
			{ path: "list", value: ["a", "b"] },
		]);
	});
});

describe("sliceMessages", () => {
	const fallback = {
		label: "Code label",
		sections: { identification: "Code ID", deep: { leaf: "Code leaf" } },
		count: (n: number) => `${n} items`,
	};
	const slice = {
		locale: "pt-BR",
		catalog: {
			"ns.label": "Rótulo",
			"ns.sections.identification": "Identificação",
			"ns.sections.deep.leaf": "Folha {param}",
			"ns.count": "DB count wins?",
		},
	};

	it("overlays string leaves at any depth, keeps functions", () => {
		const out = sliceMessages(slice, "ns", fallback);
		expect(out.label).toBe("Rótulo");
		expect(out.sections.identification).toBe("Identificação");
		expect(out.sections.deep.leaf).toBe("Code leaf"); // param-bearing → fallback
		expect(out.count(3)).toBe("3 items"); // function → untouched
	});

	it("returns fallback unchanged without a slice", () => {
		expect(sliceMessages(undefined, "ns", fallback)).toBe(fallback);
	});

	it("keeps code value on catalog miss", () => {
		const out = sliceMessages({ locale: "en", catalog: {} }, "ns", fallback);
		expect(out.label).toBe("Code label");
	});
});

describe("sliceMessages parametrized leaves", () => {
	const fallback = {
		count: paramMessage("en", "{n, plural, one {# item} other {# items}}", ["n"]),
		total: paramMessage("en", "Total: {n, number}", ["n"]),
		greet: paramMessage("en", "{a} and {b}", ["a", "b"]),
		plain: (s: string) => `plain ${s}`,
	};
	const slice = {
		locale: "pt-BR",
		catalog: {
			// Param-bearing DB template — applies because the wrapper
			// supplies args at call time (unlike string leaves).
			"ns.count": "{n, plural, one {# artigo} other {# artigos}}",
		},
	};

	it("DB template wins for parametrized leaves", () => {
		const out = sliceMessages(slice, "ns", fallback);
		expect(out.count(1)).toBe("1 artigo");
		expect(out.count(3)).toBe("3 artigos");
	});

	it("falls back to i18nTemplate on catalog miss, rendered in slice.locale", () => {
		const out = sliceMessages(slice, "ns", fallback);
		// pt-BR number formatting proves the slice locale reached
		// renderMessage — the fallback catalog binds "en".
		expect(out.total(1234.5)).toBe("Total: 1.234,5");
	});

	it("zips positional args to declared param names", () => {
		const out = sliceMessages(slice, "ns", fallback);
		expect(out.greet("Ana", "Bruno")).toBe("Ana and Bruno");
		expect(out.greet("Ana")).toBe("Ana and ");
	});

	it("keeps ParametrizedMessage metadata on the wrapper", () => {
		const out = sliceMessages(slice, "ns", fallback);
		expect(isParametrizedMessage(out.count)).toBe(true);
		expect(out.count.i18nTemplate).toBe(slice.catalog["ns.count"]);
	});

	it("plain functions still pass through untouched", () => {
		const out = sliceMessages(slice, "ns", fallback);
		expect(out.plain).toBe(fallback.plain);
		expect(out.plain("x")).toBe("plain x");
	});
});
