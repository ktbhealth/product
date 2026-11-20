import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { middlewarePanelPlugin, middlewareChromePlugin, plugins } from "./index.ts";

describe("middleware plugin manifests", () => {
	it("exports the panel and chrome plugins", () => {
		expect(plugins).toEqual([middlewarePanelPlugin, middlewareChromePlugin]);
		expect(middlewarePanelPlugin.id).toBe("middleware.panel");
		expect(middlewareChromePlugin.id).toBe("middleware.chrome");
	});

	it("declares the /platform/middleware console page", () => {
		const page = middlewarePanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("middleware.stages");
		expect(page?.path).toBe("/platform/middleware");
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("declares the sidebar entry under Runtime", () => {
		const entry = middlewareChromePlugin.chrome?.[0];
		expect(entry?.region).toBe("portal.sidebar");
		if (entry?.content.kind === "sidebarItem") {
			expect(entry.content.item.to).toBe("/platform/middleware");
			expect(entry.content.item.group).toBe("Runtime");
		} else {
			throw new Error("expected sidebarItem content");
		}
	});
});

describe("middleware page guard", () => {
	const runGuard = async (isAdmin: boolean) => {
		const { PlatformAdmin } = await import("@ktb/platform");
		const effect = middlewarePanelPlugin.panel!.pages![0]!.guard!();
		return Effect.runPromise(
			effect.pipe(
				Effect.provideService(PlatformAdmin, {
					isAdmin: () => Effect.succeed(isAdmin),
					requireAdmin: () => (isAdmin ? Effect.void : Effect.fail({ _tag: "Forbidden" } as never)),
				} as never),
			),
		);
	};

	it("admits admins and hides the page from non-admins", async () => {
		// requireAdmin fails with a Forbidden-tagged error; the guard
		// catches it into `false` — same contract as other console pages.
		await expect(runGuard(true)).resolves.toBe(true);
		await expect(runGuard(false)).resolves.toBe(false);
	});
});
