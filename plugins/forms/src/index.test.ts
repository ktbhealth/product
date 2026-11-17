import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { formsPagesPlugin, plugins } from "./index.ts";

describe("forms plugins", () => {
	it("registers the wildcard app page", () => {
		expect(plugins).toEqual([formsPagesPlugin]);
		const page = formsPagesPlugin.pages?.[0];
		expect(page?.id).toBe("forms.form");
		expect(page?.path).toBe("/forms/*");
		expect(page?.context).toBe("app");
	});

	it("loader echoes the request path", async () => {
		const page = formsPagesPlugin.pages?.[0];
		await expect(Effect.runPromise(page?.loader?.("/forms/intake") as never)).resolves.toBe(
			"/forms/intake",
		);
	});
});
