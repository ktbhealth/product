import { afterEach, describe, expect, it, vi } from "vitest";

import type { I18nShape, ScopeChain } from "@ktb/i18n";

import { getI18n, getLocale, resetServerRuntime, setServerRuntime } from "./index.ts";

afterEach(() => resetServerRuntime());

describe("getLocale", () => {
	it("reads the active locale from the registered runtime", () => {
		setServerRuntime({
			run: () => Promise.reject(new Error("unused")),
			runAs: () => Promise.reject(new Error("unused")),
			getLocale: () => "pt-BR",
			audioTranscribeModel: "test-model",
		});
		expect(getLocale()).toBe("pt-BR");
	});

	it("throws when no runtime is registered", () => {
		expect(() => getLocale()).toThrow("runtime not initialized");
	});
});

describe("getI18n", () => {
	it("delegates to the wired i18n capability", async () => {
		const shape = { marker: "i18n-shape" } as unknown as I18nShape;
		const i18n = vi.fn(
			async (input?: { locale?: string; scopeChain?: ScopeChain }) =>
				({ ...shape, input }) as unknown as I18nShape,
		);
		setServerRuntime({
			run: () => Promise.reject(new Error("unused")),
			runAs: () => Promise.reject(new Error("unused")),
			getLocale: () => "en",
			audioTranscribeModel: "test-model",
			i18n,
		});
		const out = await getI18n({ locale: "pt-BR" });
		expect(out).toEqual({ ...shape, input: { locale: "pt-BR" } });
		expect(i18n).toHaveBeenCalledWith({ locale: "pt-BR" });
	});

	it("throws when the runtime lacks the i18n capability", () => {
		setServerRuntime({
			run: () => Promise.reject(new Error("unused")),
			runAs: () => Promise.reject(new Error("unused")),
			getLocale: () => "en",
			audioTranscribeModel: "test-model",
		});
		expect(() => getI18n()).toThrow("i18n capability not wired");
	});
});
