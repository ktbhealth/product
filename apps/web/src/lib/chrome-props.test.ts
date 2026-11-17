import { describe, expect, it } from "vitest";

import type { PageI18nSlice } from "@ktb/kernel";

import { portalChromeProps } from "./chrome-props.ts";

const signOut = () => Promise.resolve();

describe("portalChromeProps", () => {
	it("defaults locales/theme and resolves localeName without a slice", () => {
		const props = portalChromeProps(null, "en", [], signOut);
		expect(props.locales).toEqual(["en"]);
		expect(props.theme).toBeNull();
		expect(props.i18n).toBeUndefined();
		// No slice → the generated English baseline names the locale.
		expect(props.localeName("pt-BR")).toBe("Português (Brasil)");
	});

	it("prefers explicit locales, then the i18n slice's enabledLocales", () => {
		const i18n: PageI18nSlice = {
			locale: "en",
			catalog: {},
			enabledLocales: ["en", "pt-BR"],
		};
		expect(portalChromeProps(null, "en", [], signOut, null, i18n).locales).toEqual(["en", "pt-BR"]);
		expect(portalChromeProps(null, "en", [], signOut, null, i18n, ["es"]).locales).toEqual(["es"]);
	});

	it("passes the resolved theme through and resolves localeName from the slice", () => {
		const i18n: PageI18nSlice = {
			locale: "en",
			catalog: { "app.locale_pt_BR": "Português (BR)" },
		};
		const props = portalChromeProps(null, "pt-BR", [], signOut, null, i18n);
		expect(props.locale).toBe("pt-BR");
		expect(props.i18n).toBe(i18n);
		// Slice catalog wins over the English baseline.
		expect(props.localeName("pt-BR")).toBe("Português (BR)");
		expect(props.localeName("es")).toBe("Español");
		expect(props.user).toBeNull();
		expect(props.signOut).toBe(signOut);
		expect(props.setLocale).toBeTypeOf("function");
	});
});
