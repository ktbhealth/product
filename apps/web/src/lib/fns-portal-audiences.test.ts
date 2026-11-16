import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

// portalAudiencesFn + the portalAudienceAllows failure path (fns.ts):
// mocked server-fn chain and platform runtime, with a controllable
// PortalAudience service — the real registry's audience proofs live in
// fns.test.ts; this file isolates the wire handler and the catch.

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

const state = vi.hoisted(() => ({
	user: null as { id: string; email: string; name: string } | null,
	/** undefined → PortalAudience absent; null → service present but
	 * audiences() fails; Set → audiences() succeeds. */
	audiences: undefined as ReadonlySet<string> | null | undefined,
}));

vi.mock("#/lib/auth.ts", () => ({
	getSessionUser: async () => state.user,
	ensureSessionUser: async () => state.user,
	getDoctorUser: async () => state.user,
	getSessionAccount: async () => null,
	ensureDoctorUser: async () => state.user,
}));

vi.mock("#/lib/platform.ts", async () => {
	const { PluginStates } = await import("@ktb/platform/plugin-states");
	const { PortalAudience } = await import("@ktb/portal");
	const states = {
		isEnabled: () => Effect.succeed(true),
		enabledIds: () => Effect.succeed(new Set<string>()),
		config: () => Effect.succeed(undefined),
		setEnabled: () => Effect.void,
		setConfig: () => Effect.void,
		entries: () => Effect.succeed([]),
	};
	const runEffect = (effect: any) => {
		let e = effect.pipe(Effect.provideService(PluginStates, states as never));
		if (state.audiences !== undefined) {
			e = e.pipe(
				Effect.provideService(PortalAudience, {
					audiences: () =>
						state.audiences === null
							? Effect.fail(new Error("audience down"))
							: Effect.succeed(state.audiences as ReadonlySet<string>),
				} as never),
			);
		}
		return Effect.runPromise(e);
	};
	return {
		run: (effect: any) => runEffect(effect),
		runAs: (_user: unknown, effect: any) => runEffect(effect),
		serverPlugins: [
			{
				id: "t.portal",
				portals: [
					{
						id: "tport",
						basePath: "/portal/tport",
						label: "T",
						audience: "member",
					},
				],
				panel: { pages: [] },
			},
		] as never,
	};
});

import type { PanelPage } from "@ktb/kernel";
import { portalPages } from "./registry.ts";
import { portalAudiencesFn, pluginStatesFn, portalPageDataFn } from "./fns.ts";

describe("pluginStatesFn", () => {
	it("returns the enabled plugin id set from the runtime", async () => {
		// The mocked PluginStates.enabledIds resolves an empty set.
		expect(await pluginStatesFn()).toEqual({ enabled: [] });
	});
});

describe("portalAudiencesFn", () => {
	it("returns [] for anonymous callers", async () => {
		state.user = null;
		state.audiences = new Set(["member"]);
		expect(await portalAudiencesFn()).toEqual([]);
	});

	it("returns [] when the audience service is not registered", async () => {
		state.user = { id: "u1", email: "a@x.com", name: "A" };
		state.audiences = undefined;
		expect(await portalAudiencesFn()).toEqual([]);
	});

	it("returns the session's audience rules, sorted", async () => {
		state.user = { id: "u1", email: "a@x.com", name: "A" };
		state.audiences = new Set(["member", "doctor", "clinician"]);
		expect(await portalAudiencesFn()).toEqual(["clinician", "doctor", "member"]);
	});
});

describe("portal audience gate failure", () => {
	it("denies the page when the audience lookup fails", async () => {
		state.user = { id: "u1", email: "a@x.com", name: "A" };
		state.audiences = null;
		const path = "/portal/tport/x";
		const page: PanelPage = {
			id: "t.page",
			path,
			component: () => null,
			loader: () => Effect.succeed("never"),
		};
		const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
		pages.set(path, { page, pluginId: "t.portal" });
		try {
			expect(await portalPageDataFn({ data: path })).toEqual({ status: "notfound" });
			// A portal path whose instance no server plugin declares
			// fails the same gate earlier — portalEntryForPath misses.
			const ghost = "/portal/ghost/x";
			const ghostPage: PanelPage = {
				id: "t.ghost",
				path: ghost,
				component: () => null,
				loader: () => Effect.succeed("never"),
			};
			pages.set(ghost, { page: ghostPage, pluginId: "t.portal" });
			state.audiences = new Set(["member"]);
			expect(await portalPageDataFn({ data: ghost })).toEqual({ status: "notfound" });
			pages.delete(ghost);
		} finally {
			pages.delete(path);
			state.audiences = undefined;
		}
	});
});
