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
	createSchemaFn,
	deleteSchemaFn,
	listSchemasFn,
	schemaDocFn,
	updateSchemaFn,
	validateSchemaFn,
} from "./fns.ts";
import { plugins } from "./index.ts";
import { Schemas, SchemasLive, SCHEMAS_TEST_DDL } from "./service.ts";

const PLUGIN_STATE_DDL = `
CREATE TABLE plugin_state (
	plugin_id TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	config TEXT,
	updated_at INTEGER NOT NULL
);
`;

// The schemas plugins depend on the platform markers — the test
// registry includes them so dep edges and PluginStates resolve like the
// host.
const registry = [platformAdminPlugin, platformRoutesPlugin, platformPanelPlugin, ...plugins];

describe("schemas fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(async () => {
		const db = makeDb(makeD1(SCHEMAS_TEST_DDL + PLUGIN_STATE_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const states = makePluginStatesLive(registry);
		const schemasLive = SchemasLive.pipe(Layer.provide(env));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(states.pipe(Layer.provide(env)), schemasLive, env) as Layer.Layer<
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
		await expect(createSchemaFn({ data: { name: "x" } })).rejects.toThrow("unauthenticated");
		await expect(updateSchemaFn({ data: { id: 1, name: "x" } })).rejects.toThrow("unauthenticated");
		await expect(deleteSchemaFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listSchemasFn()).rejects.toThrow("unauthenticated");
		// Public reads work without a session.
		await expect(schemaDocFn({ data: { id: 1 } })).resolves.toBeNull();
		await expect(validateSchemaFn({ data: { schemaId: 1, data: {} } })).resolves.toMatchObject({
			valid: false,
		});
	});

	it("rejects admin fns when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, { pluginEnabled: async () => false });
		try {
			await expect(createSchemaFn({ data: { name: "x" } })).rejects.toThrow(
				'plugin "schemas.panel" is disabled',
			);
			await expect(updateSchemaFn({ data: { id: 1, name: "x" } })).rejects.toThrow(
				'plugin "schemas.panel" is disabled',
			);
			await expect(deleteSchemaFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "schemas.panel" is disabled',
			);
			await expect(listSchemasFn()).rejects.toThrow('plugin "schemas.panel" is disabled');
			// Public reads degrade instead of throwing.
			await expect(schemaDocFn({ data: { id: 1 } })).resolves.toBeNull();
			await expect(validateSchemaFn({ data: { schemaId: 1, data: {} } })).resolves.toMatchObject({
				valid: false,
			});
		} finally {
			installRuntime(runtime);
		}
	});

	it("denies non-admin principals", async () => {
		currentEmail = "doc@x.com";
		await expect(createSchemaFn({ data: { name: "x" } })).resolves.toBeNull();
		await expect(updateSchemaFn({ data: { id: 1, name: "x" } })).resolves.toBeNull();
		await expect(deleteSchemaFn({ data: { id: 1 } })).resolves.toBe(false);
		await expect(listSchemasFn()).resolves.toEqual([]);
	});

	it("creates, reads, updates, lists, validates and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const schemaJson = JSON.stringify({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});
		const created = await createSchemaFn({
			data: { name: "page-search", description: "Page params", schema: schemaJson },
		});
		expect(created).toMatchObject({
			id: expect.any(Number),
			name: "page-search",
			description: "Page params",
			schema: schemaJson,
		});
		expect(typeof created!.updatedAt).toBe("string");

		// Public read returns the same wire shape without a session.
		currentEmail = null;
		const publicDoc = await schemaDocFn({ data: { id: created!.id } });
		expect(publicDoc).toMatchObject({ id: created!.id, name: "page-search" });
		currentEmail = "admin@x.com";

		// Handled failures → null: bad schema JSON, duplicate name,
		// missing row.
		await expect(
			updateSchemaFn({ data: { id: created!.id, schema: "not json" } }),
		).resolves.toBeNull();
		await expect(createSchemaFn({ data: { name: "page-search" } })).resolves.toBeNull();
		await expect(updateSchemaFn({ data: { id: 999, name: "ghost" } })).resolves.toBeNull();

		const updated = await updateSchemaFn({
			data: { id: created!.id, name: "page-search-2", description: "" },
		});
		expect(updated).toMatchObject({ id: created!.id, name: "page-search-2", description: null });

		// Admin picker list: metas only, no schema payload.
		const list = await listSchemasFn();
		const meta = list.find((row) => row.id === created!.id);
		expect(meta).toMatchObject({ id: created!.id, name: "page-search-2" });
		expect(meta).not.toHaveProperty("schema");
		expect(typeof meta!.updatedAt).toBe("string");

		// Public validate: valid and invalid payloads.
		currentEmail = null;
		const ok = await validateSchemaFn({ data: { schemaId: created!.id, data: { q: "x" } } });
		expect(ok).toEqual({ valid: true, issues: [] });
		const bad = await validateSchemaFn({ data: { schemaId: created!.id, data: {} } });
		expect(bad.valid).toBe(false);
		expect(bad.issues.length).toBeGreaterThan(0);
		currentEmail = "admin@x.com";

		expect(await deleteSchemaFn({ data: { id: created!.id } })).toBe(true);
		expect(await deleteSchemaFn({ data: { id: created!.id } })).toBe(false);
		await expect(schemaDocFn({ data: { id: created!.id } })).resolves.toBeNull();
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(createSchemaFn({ data: { name: "" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(createSchemaFn({ data: { name: 1 } } as never)).rejects.toBeInstanceOf(Error);
		await expect(updateSchemaFn({ data: { name: "x" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(deleteSchemaFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(schemaDocFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(
			validateSchemaFn({ data: { schemaId: "1", data: {} } } as never),
		).rejects.toBeInstanceOf(Error);
	});

	it("schemaDocFn returns null while the panel plugin is disabled", async () => {
		currentEmail = "admin@x.com";
		const created = await createSchemaFn({ data: { name: "Toggle" } });
		expect(created).not.toBeNull();
		await runtime.runPromise(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				yield* states.setEnabled(["schemas.panel"], false);
			}),
		);
		try {
			await expect(schemaDocFn({ data: { id: created!.id } })).resolves.toBeNull();
		} finally {
			await runtime.runPromise(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(["schemas.panel"], true);
				}),
			);
		}
		await expect(schemaDocFn({ data: { id: created!.id } })).resolves.toMatchObject({
			id: created!.id,
		});
	});

	it("validateSchemaFn returns the empty result while the panel plugin is disabled", async () => {
		currentEmail = null;
		await runtime.runPromise(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				yield* states.setEnabled(["schemas.panel"], false);
			}),
		);
		try {
			await expect(validateSchemaFn({ data: { schemaId: 1, data: {} } })).resolves.toEqual({
				valid: false,
				issues: [],
			});
		} finally {
			await runtime.runPromise(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(["schemas.panel"], true);
				}),
			);
		}
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stubSchemas = Schemas.of({
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminGet: () => Effect.fail({ _tag: "Other" }),
			adminCreate: () => Effect.fail({ _tag: "Other" }),
			adminUpdate: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			getById: () => Effect.fail({ _tag: "Other" }),
			validate: () => Effect.succeed({ valid: true, issues: [] }),
		} as unknown as Schemas["Service"]);
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
				Layer.succeed(Schemas, stubSchemas),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			// The stub fails with an untranslatable tag — the fns' catch
			// blocks only map the handled domain errors, so it propagates.
			await expect(createSchemaFn({ data: { name: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(updateSchemaFn({ data: { id: 1, name: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(deleteSchemaFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
			await expect(listSchemasFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(schemaDocFn({ data: { id: 1 } })).rejects.toMatchObject({ _tag: "Other" });
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("maps handled failures and rethrows plain errors", async () => {
		const stubSchemas = Schemas.of({
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
			// schemaId 1 fails with a handled domain error, schemaId 2
			// with an untranslatable one — the fn's catch collapses the
			// first to EMPTY_RESULT and rethrows the second.
			validate: (id: number) =>
				id === 1
					? Effect.fail({ _tag: "SchemaNotFound" })
					: id === 2
						? Effect.fail(new Error("plain validate failure"))
						: Effect.succeed({ valid: false, issues: [] }),
		} as unknown as Schemas["Service"]);
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
				Layer.succeed(Schemas, stubSchemas),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(createSchemaFn({ data: { name: "ok" } })).resolves.toBeNull();
			await expect(createSchemaFn({ data: { name: "FAIL" } })).rejects.toBeInstanceOf(Error);
			await expect(updateSchemaFn({ data: { id: 1, name: "x" } })).rejects.toBeInstanceOf(Error);
			const deleteError = await deleteSchemaFn({ data: { id: 1 } }).catch(
				(error: unknown) => error,
			);
			expect(deleteError).toBe("plain delete failure");
			// Public validate degrades handled failures to the empty
			// result and rethrows untranslatable ones.
			currentEmail = null;
			await expect(validateSchemaFn({ data: { schemaId: 1, data: {} } })).resolves.toEqual({
				valid: false,
				issues: [],
			});
			await expect(validateSchemaFn({ data: { schemaId: 2, data: {} } })).rejects.toBeInstanceOf(
				Error,
			);
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});
