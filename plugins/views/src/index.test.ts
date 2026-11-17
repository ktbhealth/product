import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { plugins, viewsPagesPlugin, viewsServicesPlugin } from "./index.ts";
import { Views } from "./service.ts";

const viewsStub = (over: Record<string, unknown> = {}) =>
	Views.of({
		allows: () => Effect.succeed(true),
		load: () => Effect.succeed(null),
		query: () => Effect.succeed(null),
		...over,
	} as Views["Service"]);

describe("views plugins", () => {
	it("exports the two single-concern plugins in order", () => {
		expect(plugins).toEqual([viewsServicesPlugin, viewsPagesPlugin]);
		expect(plugins.map((p) => p.id)).toEqual(["views.services", "views.pages"]);
	});

	it("declares the expected dependency edges", () => {
		expect(viewsServicesPlugin.requiredDeps).toEqual(["document-store.services"]);
		expect(viewsServicesPlugin.optionalDeps).toEqual(["rbac.services"]);
		expect(viewsPagesPlugin.requiredDeps).toEqual(["views.services"]);
	});

	it("contributes the /v/* app page whose guard and loader delegate to Views", async () => {
		const page = viewsPagesPlugin.pages?.[0];
		expect(page?.id).toBe("views.page");
		expect(page?.path).toBe("/v/*");
		expect(page?.context).toBe("app");
		if (page?.guard === undefined || page.loader === undefined) {
			throw new Error("views.pages must contribute a guarded /v/* page");
		}
		const { guard: guardFn, loader: loaderFn } = page;

		const guard = (path: string, views: Views["Service"]) =>
			Effect.runPromise(
				(guardFn(path) as Effect.Effect<boolean>).pipe(Effect.provideService(Views, views)),
			);
		await expect(guard("/v/x", viewsStub())).resolves.toBe(true);
		await expect(guard("/v/x", viewsStub({ allows: () => Effect.succeed(false) }))).resolves.toBe(
			false,
		);

		const loader = (path: string, views: Views["Service"]) =>
			Effect.runPromise(
				(loaderFn(path) as Effect.Effect<unknown>).pipe(Effect.provideService(Views, views)),
			);
		const wire = { mode: "list" };
		await expect(loader("/v/x", viewsStub({ load: () => Effect.succeed(wire) }))).resolves.toEqual(
			wire,
		);
		await expect(loader("/v/x", viewsStub())).resolves.toBeNull();
	});
});
