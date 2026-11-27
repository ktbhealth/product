import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
	platformRoutesPlugin,
} from "@ktb/platform";
import {
	makePluginStatesLive,
	PluginStates,
	type PluginStatesShape,
} from "@ktb/platform/plugin-states";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	deleteTemplateFn,
	instantiateTemplateFn,
	listTemplatesFn,
	saveTemplateFn,
	templateDocFn,
	updateTemplateFn,
} from "./fns.ts";
import { TemplateKinds, TemplateKindsLive, type TemplateKind } from "./kinds.ts";
import { plugins } from "./index.ts";
import { Templates, TemplatesLive } from "./service.ts";

const testKind: TemplateKind = {
	kind: "test-kind",
	label: "Test kind",
	serialize: (source) => Effect.succeed({ wrapped: source }),
	deserialize: (payload) =>
		Effect.succeed(
			typeof payload === "object" && payload !== null
				? (payload as { wrapped: unknown }).wrapped
				: null,
		),
	validate: (payload) =>
		Effect.succeed(
			typeof payload === "object" && payload !== null && "wrapped" in payload
				? []
				: ["payload must carry a wrapped value"],
		),
};

// The templates plugins depend on the platform markers — the test
// registry includes them so dep edges and PluginStates resolve like the
// host.
const registry = [platformAdminPlugin, platformRoutesPlugin, platformPanelPlugin, ...plugins];

describe("templates fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(async () => {
		const db = makeDb(makeTestD1());
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const states = makePluginStatesLive(registry);
		// Production wiring: Templates + the shared TemplateKinds
		// registry (with the test kind registered) in one layer.
		const templatesLive = TemplatesLive.pipe(
			Layer.provideMerge(TemplateKindsLive),
			Layer.provide(env),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(states.pipe(Layer.provide(env)), templatesLive, env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* TemplateKinds;
				yield* kinds.register(testKind);
			}),
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous admin callers but serves the public reads", async () => {
		currentEmail = null;
		await expect(
			saveTemplateFn({ data: { kind: "test-kind", name: "x", payload: { wrapped: 1 } } }),
		).rejects.toThrow("unauthenticated");
		await expect(updateTemplateFn({ data: { id: 1, name: "x" } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(deleteTemplateFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(instantiateTemplateFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listTemplatesFn()).rejects.toThrow("unauthenticated");
		// Public reads work without a session.
		await expect(templateDocFn({ data: { id: 1 } })).resolves.toBeNull();
	});

	it("saves, lists, reads, updates, instantiates and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const saved = await saveTemplateFn({
			data: { kind: "test-kind", name: "wire-1", source: { v: 1 } },
		});
		expect(saved).toMatchObject({
			kind: "test-kind",
			name: "wire-1",
			createdBy: "admin@x.com",
			payload: { wrapped: { v: 1 } },
		});
		const id = saved!.id;

		const listed = await listTemplatesFn();
		expect(listed.map((r) => r.id)).toContain(id);
		expect(listed[0]).not.toHaveProperty("payload");

		const doc = await templateDocFn({ data: { id } });
		expect(doc?.payload).toEqual({ wrapped: { v: 1 } });

		const instance = await instantiateTemplateFn({ data: { id } });
		expect(instance).toEqual({ kind: "test-kind", source: { v: 1 } });

		const updated = await updateTemplateFn({ data: { id, name: "wire-1b" } });
		expect(updated?.name).toBe("wire-1b");

		await expect(deleteTemplateFn({ data: { id } })).resolves.toBe(true);
		await expect(templateDocFn({ data: { id } })).resolves.toBeNull();
	});

	it("collapses handled domain failures to null/false/[]", async () => {
		currentEmail = "admin@x.com";
		// Unknown kind.
		await expect(
			saveTemplateFn({ data: { kind: "ghost", name: "x", payload: {} } }),
		).resolves.toBeNull();
		// Invalid payload (missing `wrapped`).
		await expect(
			saveTemplateFn({ data: { kind: "test-kind", name: "x", payload: { nope: 1 } } }),
		).resolves.toBeNull();
		// Duplicate name.
		await saveTemplateFn({
			data: { kind: "test-kind", name: "dup", payload: { wrapped: 1 } },
		});
		await expect(
			saveTemplateFn({ data: { kind: "test-kind", name: "dup", payload: { wrapped: 2 } } }),
		).resolves.toBeNull();
		// Missing row on update/delete/instantiate.
		await expect(updateTemplateFn({ data: { id: 999999, name: "x" } })).resolves.toBeNull();
		await expect(deleteTemplateFn({ data: { id: 999999 } })).resolves.toBe(false);
		await expect(instantiateTemplateFn({ data: { id: 999999 } })).resolves.toBeNull();
	});

	it("denies non-admin callers with handled failures", async () => {
		currentEmail = "doc@x.com";
		await expect(
			saveTemplateFn({ data: { kind: "test-kind", name: "x", payload: { wrapped: 1 } } }),
		).resolves.toBeNull();
		await expect(deleteTemplateFn({ data: { id: 1 } })).resolves.toBe(false);
		await expect(listTemplatesFn()).resolves.toEqual([]);
		await expect(instantiateTemplateFn({ data: { id: 1 } })).resolves.toBeNull();
	});

	it("propagates unexpected service errors and honors the disabled gate", async () => {
		let enabled = true;
		const stubTemplates = Templates.of({
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminGet: () => Effect.fail({ _tag: "Other" }),
			listByKind: () => Effect.succeed([]),
			// name "NULL" resolves null (empty insert returning); every
			// other call fails with an untranslatable tag.
			save: (input: { name?: string }) =>
				input.name === "NULL" ? Effect.succeed(null) : Effect.fail({ _tag: "Other" }),
			adminUpdate: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			instantiate: () => Effect.fail({ _tag: "Other" }),
			getById: (id: number) => (id === 1 ? Effect.succeed(null) : Effect.fail({ _tag: "Other" })),
		} as unknown as Templates["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(PluginStates, {
					isEnabled: () => Effect.succeed(enabled),
					enabledIds: () => Effect.succeed(new Set<string>()),
					config: () => Effect.succeed({}),
					setEnabled: () => Effect.void,
					setConfig: () => Effect.void,
					entries: () => Effect.succeed([]),
				} as unknown as PluginStatesShape),
				Layer.succeed(Templates, stubTemplates),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			// The stub fails with an untranslatable tag — the fns' catch
			// blocks only map the handled domain errors, so it propagates.
			await expect(
				saveTemplateFn({ data: { kind: "k", name: "x", payload: {} } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(updateTemplateFn({ data: { id: 1, name: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(deleteTemplateFn({ data: { id: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(instantiateTemplateFn({ data: { id: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(listTemplatesFn()).rejects.toMatchObject({ _tag: "Other" });
			// A null save result passes through as null.
			await expect(
				saveTemplateFn({ data: { kind: "k", name: "NULL", payload: {} } }),
			).resolves.toBeNull();
			// The public read propagates service errors and resolves null
			// while the plugin is disabled.
			await expect(templateDocFn({ data: { id: 2 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			enabled = false;
			await expect(templateDocFn({ data: { id: 1 } })).resolves.toBeNull();
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});
