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
import { makeD1 } from "@ktb/db/testing";
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
	createLayoutFn,
	deleteLayoutFn,
	layoutDocFn,
	listLayoutsFn,
	updateLayoutFn,
} from "./fns.ts";
import { plugins } from "./index.ts";
import { LAYOUTS_TEST_DDL, Layouts, LayoutsLive } from "./service.ts";

const PLUGIN_STATE_DDL = `
CREATE TABLE plugin_state (
	plugin_id TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	config TEXT,
	updated_at INTEGER NOT NULL
);
`;

const CONFIG = JSON.stringify({
	sections: [{ id: "s1", title: "Hero", kind: "rich-text", refId: 1 }],
});

// The layouts plugins depend on the platform markers — the test
// registry includes them so dep edges and PluginStates resolve like the
// host.
const registry = [platformAdminPlugin, platformRoutesPlugin, platformPanelPlugin, ...plugins];

describe("layouts fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(async () => {
		const db = makeDb(makeD1(LAYOUTS_TEST_DDL + PLUGIN_STATE_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const states = makePluginStatesLive(registry);
		const layoutsLive = LayoutsLive.pipe(Layer.provide(env));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(states.pipe(Layer.provide(env)), layoutsLive, env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous admin callers but serves the public reads", async () => {
		currentEmail = null;
		await expect(createLayoutFn({ data: { name: "x" } })).rejects.toThrow("unauthenticated");
		await expect(updateLayoutFn({ data: { id: 1, name: "x" } })).rejects.toThrow("unauthenticated");
		await expect(deleteLayoutFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listLayoutsFn()).rejects.toThrow("unauthenticated");
		// Public reads work without a session.
		await expect(layoutDocFn({ data: { id: 1 } })).resolves.toBeNull();
	});

	it("rejects admin fns when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, { pluginEnabled: async () => false });
		try {
			await expect(createLayoutFn({ data: { name: "x" } })).rejects.toThrow(
				'plugin "layouts.panel" is disabled',
			);
			await expect(updateLayoutFn({ data: { id: 1, name: "x" } })).rejects.toThrow(
				'plugin "layouts.panel" is disabled',
			);
			await expect(deleteLayoutFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "layouts.panel" is disabled',
			);
			await expect(listLayoutsFn()).rejects.toThrow('plugin "layouts.panel" is disabled');
			// Public reads degrade instead of throwing.
			await expect(layoutDocFn({ data: { id: 1 } })).resolves.toBeNull();
		} finally {
			installRuntime(runtime);
		}
	});

	it("denies non-admin principals", async () => {
		currentEmail = "doc@x.com";
		await expect(createLayoutFn({ data: { name: "x" } })).resolves.toBeNull();
		await expect(updateLayoutFn({ data: { id: 1, name: "x" } })).resolves.toBeNull();
		await expect(deleteLayoutFn({ data: { id: 1 } })).resolves.toBe(false);
		await expect(listLayoutsFn()).resolves.toEqual([]);
	});

	it("creates, reads, updates, lists and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const created = await createLayoutFn({
			data: { name: "landing", description: "Landing body", config: CONFIG },
		});
		expect(created).toMatchObject({
			id: expect.any(Number),
			name: "landing",
			description: "Landing body",
			config: CONFIG,
			sectionCount: 1,
		});
		expect(typeof created!.updatedAt).toBe("string");

		// Public read returns the same wire shape without a session.
		currentEmail = null;
		const publicDoc = await layoutDocFn({ data: { id: created!.id } });
		expect(publicDoc).toMatchObject({ id: created!.id, name: "landing" });
		currentEmail = "admin@x.com";

		// Handled failures → null: bad config JSON, duplicate name,
		// missing row.
		await expect(
			updateLayoutFn({ data: { id: created!.id, config: "not json" } }),
		).resolves.toBeNull();
		await expect(
			updateLayoutFn({
				data: {
					id: created!.id,
					config: '{"sections":[{"id":"a","title":"A","kind":"video","refId":1}]}',
				},
			}),
		).resolves.toBeNull();
		await expect(createLayoutFn({ data: { name: "landing" } })).resolves.toBeNull();
		await expect(updateLayoutFn({ data: { id: 999, name: "ghost" } })).resolves.toBeNull();

		const updated = await updateLayoutFn({
			data: { id: created!.id, name: "landing-2", description: "" },
		});
		expect(updated).toMatchObject({
			id: created!.id,
			name: "landing-2",
			description: null,
		});

		// Admin picker list: metas only, no config payload.
		const list = await listLayoutsFn();
		const meta = list.find((row) => row.id === created!.id);
		expect(meta).toMatchObject({ id: created!.id, name: "landing-2", sectionCount: 1 });
		expect(meta).not.toHaveProperty("config");
		expect(typeof meta!.updatedAt).toBe("string");

		expect(await deleteLayoutFn({ data: { id: created!.id } })).toBe(true);
		expect(await deleteLayoutFn({ data: { id: created!.id } })).toBe(false);
		await expect(layoutDocFn({ data: { id: created!.id } })).resolves.toBeNull();
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(createLayoutFn({ data: { name: "" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(createLayoutFn({ data: { name: 1 } } as never)).rejects.toBeInstanceOf(Error);
		await expect(updateLayoutFn({ data: { name: "x" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(deleteLayoutFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(layoutDocFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
	});

	it("layoutDocFn returns null while the panel plugin is disabled", async () => {
		currentEmail = "admin@x.com";
		const created = await createLayoutFn({ data: { name: "Toggle" } });
		expect(created).not.toBeNull();
		await runtime.runPromise(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				yield* states.setEnabled(["layouts.panel"], false);
			}),
		);
		try {
			await expect(layoutDocFn({ data: { id: created!.id } })).resolves.toBeNull();
		} finally {
			await runtime.runPromise(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(["layouts.panel"], true);
				}),
			);
		}
		await expect(layoutDocFn({ data: { id: created!.id } })).resolves.toMatchObject({
			id: created!.id,
		});
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stubLayouts = Layouts.of({
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminGet: () => Effect.fail({ _tag: "Other" }),
			adminCreate: () => Effect.fail({ _tag: "Other" }),
			adminUpdate: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			getById: () => Effect.fail({ _tag: "Other" }),
			resolveForPage: () => Effect.succeed([]),
		} as unknown as Layouts["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(PluginStates, {
					isEnabled: () => Effect.succeed(true),
					enabledIds: () => Effect.succeed(new Set<string>()),
					config: () => Effect.succeed({}),
					setEnabled: () => Effect.void,
					setConfig: () => Effect.void,
					entries: () => Effect.succeed([]),
				} as unknown as PluginStatesShape),
				Layer.succeed(Layouts, stubLayouts),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			// The stub fails with an untranslatable tag — the fns' catch
			// blocks only map the handled domain errors, so it propagates.
			await expect(createLayoutFn({ data: { name: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(updateLayoutFn({ data: { id: 1, name: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(deleteLayoutFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
			await expect(listLayoutsFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(layoutDocFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("maps handled failures and rethrows plain errors", async () => {
		const stubLayouts = Layouts.of({
			adminList: () => Effect.succeed([]),
			adminGet: () => Effect.succeed(null),
			// adminCreate can legitimately resolve null (empty insert
			// returning) — the fn must pass that through as null. A
			// sentinel name fails with a non-domain error to exercise
			// the catch's rethrow path.
			adminCreate: (input: { name: string }) =>
				input.name === "FAIL"
					? Effect.fail(new Error("plain create failure"))
					: Effect.succeed(null),
			adminUpdate: () => Effect.fail(new Error("plain update failure")),
			adminRemove: () => Effect.fail("plain delete failure"),
			getById: () => Effect.succeed(null),
			resolveForPage: () => Effect.succeed([]),
		} as unknown as Layouts["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(PluginStates, {
					isEnabled: () => Effect.succeed(true),
					enabledIds: () => Effect.succeed(new Set<string>()),
					config: () => Effect.succeed({}),
					setEnabled: () => Effect.void,
					setConfig: () => Effect.void,
					entries: () => Effect.succeed([]),
				} as unknown as PluginStatesShape),
				Layer.succeed(Layouts, stubLayouts),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(createLayoutFn({ data: { name: "ok" } })).resolves.toBeNull();
			await expect(createLayoutFn({ data: { name: "FAIL" } })).rejects.toBeInstanceOf(Error);
			await expect(updateLayoutFn({ data: { id: 1, name: "x" } })).rejects.toBeInstanceOf(Error);
			const deleteError = await deleteLayoutFn({ data: { id: 1 } }).catch(
				(error: unknown) => error,
			);
			expect(deleteError).toBe("plain delete failure");
			// Public reads pass through the stub (null doc).
			currentEmail = null;
			await expect(layoutDocFn({ data: { id: 1 } })).resolves.toBeNull();
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});
