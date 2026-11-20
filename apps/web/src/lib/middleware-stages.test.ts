import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import type { MiddlewareContext, MiddlewareStage, PortalInstance } from "@ktb/kernel";
import { PluginStates } from "@ktb/platform/plugin-states";
import { PortalAudience } from "@ktb/portal";

import { builtinMiddlewareStages } from "./middleware-stages.ts";

const state = vi.hoisted(() => ({
	sessionUser: null as { id: string; email: string } | null,
	doctorUser: null as { id: string; email: string } | null,
}));

vi.mock("#/lib/auth.ts", () => ({
	getSessionUser: async () => state.sessionUser,
	getDoctorUser: async () => state.doctorUser,
}));

const stage = (id: string): MiddlewareStage => {
	const found = builtinMiddlewareStages.find((s) => s.id === id);
	if (found === undefined) throw new Error(`stage ${id} not registered`);
	return found;
};

const ctx = (overrides: Partial<MiddlewareContext> = {}): MiddlewareContext => ({
	path: "/portal/doctor/x",
	context: "portal",
	state: {},
	...overrides,
});

const pluginStates = (enabled: ReadonlySet<string>, enabledFlag = true) =>
	({
		isEnabled: (id: string) => Effect.succeed(enabledFlag && enabled.has(id)),
		enabledIds: () => Effect.succeed(enabled),
	}) as never;

const run = (
	id: string,
	c: MiddlewareContext,
	services: { states?: unknown; audiences?: unknown } = {},
) => {
	let effect = stage(id).handler(c) as Effect.Effect<unknown, unknown, unknown>;
	if (services.states !== undefined) {
		effect = effect.pipe(Effect.provideService(PluginStates, services.states as never));
	}
	if (services.audiences !== undefined) {
		effect = effect.pipe(Effect.provideService(PortalAudience, services.audiences as never));
	}
	// Stage handlers declare `unknown` requirements; the test provides
	// every service the built-ins yield, so the remainder is empty.
	return Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>);
};

const audiences = (set: ReadonlySet<string>) => ({
	audiences: () => Effect.succeed(set),
});

const failingAudiences = { audiences: () => Effect.fail(new Error("audience down")) };

const instance = (overrides: Partial<PortalInstance> = {}): PortalInstance => ({
	id: "doctor",
	basePath: "/portal/doctor",
	label: "Doctor",
	...overrides,
});

describe("ktb.principal.session", () => {
	it("stores the session user and continues on app pages, anonymous included", async () => {
		state.sessionUser = { id: "u1", email: "d@x.com" };
		const c = ctx({ path: "/app/x", context: "app" });
		await expect(run("ktb.principal.session", c)).resolves.toEqual({ type: "continue" });
		expect(c.state.user).toEqual({ id: "u1", email: "d@x.com" });
		state.sessionUser = null;
		const anon = ctx({ path: "/app/public", context: "app" });
		await expect(run("ktb.principal.session", anon)).resolves.toEqual({ type: "continue" });
		expect(anon.state.user).toBeNull();
	});

	it("denies anonymous portal requests but admits signed-in ones", async () => {
		state.sessionUser = null;
		await expect(run("ktb.principal.session", ctx())).resolves.toEqual({
			type: "deny",
			reason: "unauthenticated",
		});
		state.sessionUser = { id: "u1", email: "d@x.com" };
		await expect(run("ktb.principal.session", ctx())).resolves.toEqual({ type: "continue" });
	});

	it("resolves the doctor-acting user when subject is doctor", async () => {
		state.sessionUser = { id: "account", email: "a@x.com" };
		state.doctorUser = { id: "doc1", email: "doc@x.com" };
		const c = ctx({ subject: "doctor", portalInstance: instance({ subject: "doctor" }) });
		await expect(run("ktb.principal.session", c)).resolves.toEqual({ type: "continue" });
		expect(c.state.user).toEqual({ id: "doc1", email: "doc@x.com" });
		state.doctorUser = null;
		await expect(run("ktb.principal.session", ctx({ subject: "doctor" }))).resolves.toEqual({
			type: "deny",
			reason: "unauthenticated",
		});
	});
});

describe("ktb.plugin.enabled", () => {
	it("passes requests without a resolved owner", async () => {
		await expect(run("ktb.plugin.enabled", ctx())).resolves.toEqual({ type: "continue" });
	});

	it("checks per-plugin enablement when the owner has no pkg stamp", async () => {
		const on = ctx({ owner: { pluginId: "pages.a" } });
		await expect(
			run("ktb.plugin.enabled", on, { states: pluginStates(new Set(["pages.a"])) }),
		).resolves.toEqual({ type: "continue" });
		const off = ctx({ owner: { pluginId: "pages.b" } });
		await expect(
			run("ktb.plugin.enabled", off, { states: pluginStates(new Set(["pages.a"])) }),
		).resolves.toEqual({ type: "deny", reason: "plugin-disabled" });
	});

	it("checks package-granular enablement when the owner carries a pkg", async () => {
		const plugins = [
			{ id: "pkg.a", pkg: "pkg" },
			{ id: "pkg.b", pkg: "pkg" },
		] as never;
		const live = ctx({ owner: { pluginId: "pkg.a", pkg: "pkg" }, plugins });
		await expect(
			run("ktb.plugin.enabled", live, { states: pluginStates(new Set(["pkg.b"])) }),
		).resolves.toEqual({ type: "continue" });
		const dead = ctx({ owner: { pluginId: "pkg.a", pkg: "pkg" }, plugins });
		await expect(
			run("ktb.plugin.enabled", dead, { states: pluginStates(new Set()) }),
		).resolves.toEqual({ type: "deny", reason: "plugin-disabled" });
	});

	it("fails closed when the registry list is absent", async () => {
		const c = ctx({ owner: { pluginId: "pkg.a", pkg: "pkg" } });
		await expect(
			run("ktb.plugin.enabled", c, { states: pluginStates(new Set(["pkg.a"])) }),
		).resolves.toEqual({ type: "deny", reason: "plugin-disabled" });
	});
});

describe("ktb.portal.audience", () => {
	it("denies when no portal instance resolved for the path", async () => {
		await expect(run("ktb.portal.audience", ctx())).resolves.toEqual({
			type: "deny",
			reason: "unknown-portal",
		});
	});

	it("continues when the PortalAudience service is absent", async () => {
		await expect(run("ktb.portal.audience", ctx({ portalInstance: instance() }))).resolves.toEqual({
			type: "continue",
		});
	});

	it("admits when the bound audiences satisfy the instance rule", async () => {
		const c = ctx({ portalInstance: instance({ audience: "doctor" }) });
		await expect(
			run("ktb.portal.audience", c, { audiences: audiences(new Set(["doctor"])) }),
		).resolves.toEqual({ type: "continue" });
	});

	it("admits every instance for the superadmin wildcard", async () => {
		const c = ctx({ portalInstance: instance({ audience: "patient" }) });
		await expect(
			run("ktb.portal.audience", c, { audiences: audiences(new Set(["superadmin"])) }),
		).resolves.toEqual({ type: "continue" });
	});

	it("denies when the audiences do not satisfy the rule", async () => {
		const c = ctx({ portalInstance: instance({ audience: "doctor" }) });
		await expect(
			run("ktb.portal.audience", c, { audiences: audiences(new Set(["patient"])) }),
		).resolves.toEqual({ type: "deny", reason: "portal-audience" });
	});

	it("denies when the audience lookup fails", async () => {
		await expect(
			run("ktb.portal.audience", ctx({ portalInstance: instance() }), {
				audiences: failingAudiences,
			}),
		).resolves.toEqual({ type: "deny", reason: "portal-audience" });
	});
});
