import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import { devCaptureTestPagesPlugin, plugins } from "./index.ts";

describe("dev-capture-test plugins", () => {
	it("registers the /capture-test app page", () => {
		expect(plugins).toEqual([devCaptureTestPagesPlugin]);
		const page = devCaptureTestPagesPlugin.pages?.[0];
		expect(page?.id).toBe("dev-capture-test.capture");
		expect(page?.path).toBe("/capture-test");
		expect(page?.context).toBe("app");
		expect(page?.component).toBeTypeOf("function");
		expect(page?.beforeLoad).toBeTypeOf("function");
		expect(page?.guard).toBeTypeOf("function");
	});

	it("beforeLoad fails closed to not-found outside development", async () => {
		const page = devCaptureTestPagesPlugin.pages?.[0];
		vi.stubEnv("DEV", false);
		try {
			await expect(Promise.resolve(page?.beforeLoad?.({} as never))).resolves.toEqual({
				notFound: true,
			});
			await expect(Effect.runPromise(page?.guard?.("/capture-test") as never)).resolves.toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
		await expect(Promise.resolve(page?.beforeLoad?.({} as never))).resolves.toBeUndefined();
		await expect(Effect.runPromise(page?.guard?.("/capture-test") as never)).resolves.toBe(true);
	});
});
