import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	// Fresh Headers per call: @ktb/server-fns memoizes session lookups
	// per request keyed on the Headers identity.
	getRequestHeaders: () => new Headers(headers.current),
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

import { definePlugin } from "@ktb/kernel";
import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformPanelPlugin,
	platformRoutesPlugin,
} from "@ktb/platform";
import {
	makePluginStatesLive,
	PluginStates,
	type PluginStatesShape,
} from "@ktb/platform/plugin-states";
import { Principal } from "@ktb/authz";
import { Telemetry } from "@ktb/observability";
import { resetServerRuntime, setServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { managerChromePlugin, managerPanelPlugin, plugins } from "./index.ts";
import {
	getMetricsFn,
	getPluginConfigFn,
	listPluginStatesFn,
	setPluginConfigFn,
	setPluginEnabledFn,
} from "./fns.ts";

const DDL = `
CREATE TABLE plugin_state (
	plugin_id TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	config TEXT,
	updated_at INTEGER NOT NULL
);
`;

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"test.toggle": true;
	}
}

// Every platform/manager plugin is `system: true` (P-062) — the toggle
// tests need one ordinary disableable plugin in the registry.
const togglePlugin = definePlugin({ id: "test.toggle" });

// The manager plugins require platform.panel/platform.routes — the test
// registry includes them so the dep invariant holds.
const registry = [platformRoutesPlugin, platformPanelPlugin, togglePlugin, ...plugins];

const sessionFor = (email: string | null) =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

describe("manager fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	let auth: ReturnType<typeof Auth.of>;
	// Mutable scrape payload — tests swap in different expositions, and
	// `scrapeImpl` can be swapped for a failing effect.
	let scrapeText = "";
	let scrapeImpl: () => Effect.Effect<string> = () => Effect.sync(() => scrapeText);

	// (Re)install the server-runtime registry against `rt` — the error
	// propagation test swaps in a stub PluginStates and restores this.
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) => {
		setServerRuntime({
			run: (effect) => rt.runPromise(effect.pipe(Effect.provideService(Auth, auth))),
			runAs: (user, effect) =>
				rt.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
					),
				),
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
	};

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(
				Telemetry,
				Telemetry.of({
					flush: Effect.void,
					scrape: Effect.suspend(() => scrapeImpl()),
					ingest: () => Effect.void,
					health: Effect.succeed({ logs: "console", traces: "off", metrics: "prometheus" }),
				}),
			),
		);
		const states = makePluginStatesLive(registry);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(states.pipe(Layer.provide(env)), env) as Layer.Layer<unknown, never, never>,
		);
		auth = Auth.of({
			getSession: async () => sessionFor(currentEmail) as never,
			setUserBanned: async () => {},
		});
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		expect(await listPluginStatesFn()).toBeNull();
		expect(await getPluginConfigFn({ data: "manager.panel" })).toBeNull();
		expect(await getMetricsFn()).toBeNull();
		await expect(
			setPluginEnabledFn({ data: { ids: ["manager.chrome"], enabled: false } }),
		).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals", async () => {
		currentEmail = "user@x.com";
		expect(await listPluginStatesFn()).toBeNull();
		expect(await getPluginConfigFn({ data: "manager.panel" })).toBeNull();
		expect(await setPluginEnabledFn({ data: { ids: ["manager.chrome"], enabled: false } })).toBe(
			false,
		);
		expect(await setPluginConfigFn({ data: { pluginId: "manager.panel", config: {} } })).toBe(
			false,
		);
		expect(await getMetricsFn()).toBeNull();
	});

	it("lists, toggles and configures plugins as admin", async () => {
		currentEmail = "admin@x.com";
		const entries = await listPluginStatesFn();
		expect(entries?.map((e) => e.pluginId)).toEqual([
			"platform.routes",
			"platform.panel",
			"test.toggle",
			"manager.chrome",
			"manager.panel",
		]);
		// System plugins surface their flag; ordinary plugins report false.
		expect(entries?.find((e) => e.pluginId === "platform.panel")).toMatchObject({
			enabled: true,
			system: true,
		});
		expect(entries?.find((e) => e.pluginId === "test.toggle")).toMatchObject({
			enabled: true,
			system: false,
		});

		// Disable the toggle plugin — no dependents, single id.
		expect(await setPluginEnabledFn({ data: { ids: ["test.toggle"], enabled: false } })).toBe(true);
		const after = await listPluginStatesFn();
		expect(after?.find((e) => e.pluginId === "test.toggle")?.enabled).toBe(false);
		expect(await getPluginConfigFn({ data: "manager.panel" })).toEqual({ cascadeConfirm: true });

		// Config write merges defaults; invalid input rejects.
		expect(
			await setPluginConfigFn({
				data: { pluginId: "manager.panel", config: { cascadeConfirm: false } },
			}),
		).toBe(true);
		expect(await getPluginConfigFn({ data: "manager.panel" })).toEqual({ cascadeConfirm: false });
		await expect(
			setPluginConfigFn({ data: { pluginId: "manager.panel", config: { cascadeConfirm: "yes" } } }),
		).rejects.toMatchObject({ _tag: "InvalidPluginConfig" });

		// Wire inputs are Schema-validated before the handler runs.
		await expect(
			setPluginEnabledFn({ data: { ids: "manager.chrome", enabled: false } } as never),
		).rejects.toThrow();
		await expect(setPluginConfigFn({ data: { pluginId: 42 } } as never)).rejects.toThrow();

		// Unknown ids and dep violations surface as typed errors.
		await expect(
			setPluginEnabledFn({ data: { ids: ["nope"], enabled: false } }),
		).rejects.toMatchObject({ _tag: "UnknownPlugin" });
		// platform.panel is a system plugin — disabling it is rejected
		// before the dep invariant is even consulted (P-062).
		await expect(
			setPluginEnabledFn({ data: { ids: ["platform.panel"], enabled: false } }),
		).rejects.toMatchObject({ _tag: "PluginSystemLocked" });
		// Same for the manager's own entries.
		await expect(
			setPluginEnabledFn({ data: { ids: ["manager.chrome"], enabled: false } }),
		).rejects.toMatchObject({ _tag: "PluginSystemLocked" });
	});

	it("returns aggregated metrics from the Telemetry scrape for admins", async () => {
		currentEmail = "admin@x.com";
		scrapeText = [
			'ktb_server_fn_requests_total{fn="aaa",status="200"} 3',
			'ktb_server_fn_requests_total{fn="aaa",status="500"} 1',
			'ktb_server_fn_request_duration_ms_sum{fn="aaa"} 200',
			'ktb_server_fn_request_duration_ms_count{fn="aaa"} 4',
			'ktb_session_context_lookups_total{context="session",result="load"} 2',
			'ktb_session_context_lookups_total{context="session",result="cache"} 5',
			'ktb_session_context_load_duration_ms_sum{context="session"} 40',
			'ktb_session_context_load_duration_ms_count{context="session"} 2',
			"# unrelated exposition ignored",
			'ktb_other_total{fn="zzz"} 9',
		].join("\n");
		expect(await getMetricsFn()).toEqual({
			serverFns: [{ fn: "aaa", requests: 4, errors: 1, avgDurationMs: 50 }],
			sessionContexts: [{ context: "session", lookups: 7, loads: 2, avgLoadDurationMs: 20 }],
		});
		scrapeText = "";
		expect(await getMetricsFn()).toEqual({ serverFns: [], sessionContexts: [] });
	});

	it("rethrows non-Forbidden failures from the metrics scrape", async () => {
		currentEmail = "admin@x.com";
		// Tagged but not Forbidden — the catch must not map it to null.
		scrapeImpl = () => Effect.fail({ _tag: "Boom" }) as unknown as Effect.Effect<string>;
		try {
			await expect(getMetricsFn()).rejects.toMatchObject({ _tag: "Boom" });
		} finally {
			scrapeImpl = () => Effect.sync(() => scrapeText);
		}
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		// A stub PluginStates whose every method fails with `failure` —
		// the fns' catch blocks only translate Forbidden/UnknownPlugin;
		// anything else (tagged or not) must reach the caller.
		let failure: unknown = { _tag: "Other" };
		const stubStates = PluginStates.of({
			isEnabled: () => Effect.succeed(true),
			enabledIds: () => Effect.succeed(new Set<string>()),
			config: () => Effect.fail(failure),
			setEnabled: () => Effect.fail(failure),
			setConfig: () => Effect.fail(failure),
			entries: () => Effect.fail(failure),
		} as unknown as PluginStatesShape);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(PluginStates, stubStates),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		const calls = [
			() => listPluginStatesFn(),
			() => getPluginConfigFn({ data: "manager.panel" }),
			() => setPluginEnabledFn({ data: { ids: ["manager.chrome"], enabled: false } }),
			() => setPluginConfigFn({ data: { pluginId: "manager.panel", config: {} } }),
			// The stub runtime has no Telemetry service — the metrics fn
			// must surface that failure rather than mapping it to null.
			() => getMetricsFn(),
		];
		try {
			for (const failureValue of [
				{ _tag: "Other" }, // tagged but not translatable
				new Error("db gone"), // plain Error — no _tag
				null, // null fails the object check
				"string-failure", // non-object rejection
			]) {
				failure = failureValue;
				for (const call of calls) {
					let threw = false;
					try {
						await call();
					} catch {
						threw = true;
					}
					expect(threw).toBe(true);
				}
			}
			// UnknownPlugin on the config read maps to null like Forbidden.
			failure = { _tag: "UnknownPlugin" };
			await expect(getPluginConfigFn({ data: "manager.panel" })).resolves.toBeNull();
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});
