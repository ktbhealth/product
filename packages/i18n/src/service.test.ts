import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { bindNamespace, I18n, type I18nShape } from "./service.ts";
import { GLOBAL_SCOPE, localeChain } from "./resolve.ts";

const fakeI18n = (seen: string[]): I18nShape => ({
	t: (key) =>
		Effect.sync(() => {
			seen.push(key);
			return `resolved:${key}`;
		}),
	resolve: () =>
		Effect.succeed({
			template: "t",
			source: { kind: "hit" as const, scope: "global" as const, locale: "en", version: 1 },
		}),
	scopeChain: GLOBAL_SCOPE,
	locales: localeChain(["en"], "en"),
	paramsFor: () => Effect.succeed([]),
});

describe("bindNamespace", () => {
	it("prefixes keys with the bound namespace and forwards params", async () => {
		const seen: string[] = [];
		const t = bindNamespace(fakeI18n(seen), "patients");
		const params = { n: 1 };
		const out = await Effect.runPromise(t("list.title", params));
		expect(out).toBe("resolved:patients.list.title");
		expect(seen).toEqual(["patients.list.title"]);
	});
});
