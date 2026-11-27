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
	createRichTextFn,
	deleteRichTextFn,
	listRichTextDocsFn,
	richTextDocFn,
	richTextUsageFn,
	updateRichTextFn,
} from "./fns.ts";
import { RichTextDeleteHooks, RichTextDeleteHooksLive } from "./delete-hooks.ts";
import { plugins } from "./index.ts";
import { RichTexts, RichTextsLive } from "./service.ts";

// The rich-text plugins depend on the platform markers — the test
// registry includes them so dep edges and PluginStates resolve like the
// host.
const registry = [platformAdminPlugin, platformRoutesPlugin, platformPanelPlugin, ...plugins];

describe("rich-text fns", () => {
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
		const richTexts = RichTextsLive.pipe(Layer.provide(env));
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				states.pipe(Layer.provide(env)),
				richTexts,
				RichTextDeleteHooksLive,
				env,
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous admin callers but serves the public doc read", async () => {
		currentEmail = null;
		await expect(createRichTextFn({ data: {} })).rejects.toThrow("unauthenticated");
		await expect(deleteRichTextFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(richTextUsageFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listRichTextDocsFn()).rejects.toThrow("unauthenticated");
		// Public read works without a session.
		await expect(richTextDocFn({ data: { id: 1 } })).resolves.toBeNull();
	});

	it("rejects admin fns when the plugin package is disabled", async () => {
		currentEmail = "admin@x.com";
		installServerFnRuntime(runtime, auth, { pluginEnabled: async () => false });
		try {
			await expect(createRichTextFn({ data: {} })).rejects.toThrow(
				'plugin "rich-text.panel" is disabled',
			);
			await expect(updateRichTextFn({ data: { id: 1, title: "x" } })).rejects.toThrow(
				'plugin "rich-text.panel" is disabled',
			);
			await expect(deleteRichTextFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "rich-text.panel" is disabled',
			);
			await expect(richTextUsageFn({ data: { id: 1 } })).rejects.toThrow(
				'plugin "rich-text.panel" is disabled',
			);
			await expect(listRichTextDocsFn()).rejects.toThrow('plugin "rich-text.panel" is disabled');
		} finally {
			installRuntime(runtime);
		}
	});

	it("denies non-admin principals", async () => {
		currentEmail = "doc@x.com";
		await expect(createRichTextFn({ data: {} })).resolves.toBeNull();
		await expect(updateRichTextFn({ data: { id: 1, title: "x" } })).resolves.toBeNull();
		await expect(deleteRichTextFn({ data: { id: 1 } })).resolves.toBe(false);
		await expect(richTextUsageFn({ data: { id: 1 } })).resolves.toEqual([]);
		await expect(listRichTextDocsFn()).resolves.toEqual([]);
	});

	it("creates, reads, updates, lists and deletes as admin", async () => {
		currentEmail = "admin@x.com";
		const created = await createRichTextFn({ data: { title: "Doc" } });
		expect(created).toMatchObject({
			id: expect.any(Number),
			title: "Doc",
			content: [{ type: "p", children: [{ text: "" }] }],
		});
		expect(typeof created!.updatedAt).toBe("string");

		// Public read returns the same wire shape without a session.
		currentEmail = null;
		const publicDoc = await richTextDocFn({ data: { id: created!.id } });
		expect(publicDoc).toMatchObject({ id: created!.id, title: "Doc" });
		currentEmail = "admin@x.com";

		// Invalid value JSON → handled failure → null.
		await expect(
			updateRichTextFn({ data: { id: created!.id, value: "not json" } }),
		).resolves.toBeNull();
		await expect(updateRichTextFn({ data: { id: 999, title: "ghost" } })).resolves.toBeNull();

		const value = JSON.stringify([{ type: "p", children: [{ text: "body", bold: true }] }]);
		const updated = await updateRichTextFn({
			data: { id: created!.id, title: "Doc 2", value },
		});
		expect(updated).toMatchObject({ id: created!.id, title: "Doc 2" });
		expect(updated!.content).toEqual([{ type: "p", children: [{ text: "body", bold: true }] }]);

		// Admin picker list: metas only, no content payload.
		const list = await listRichTextDocsFn();
		const meta = list.find((row) => row.id === created!.id);
		expect(meta).toMatchObject({ id: created!.id, title: "Doc 2" });
		expect(meta).not.toHaveProperty("content");
		expect(typeof meta!.updatedAt).toBe("string");

		expect(await deleteRichTextFn({ data: { id: created!.id } })).toBe(true);
		expect(await deleteRichTextFn({ data: { id: created!.id } })).toBe(false);
		await expect(richTextDocFn({ data: { id: created!.id } })).resolves.toBeNull();
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(createRichTextFn({ data: { title: 1 } } as never)).rejects.toBeInstanceOf(Error);
		await expect(updateRichTextFn({ data: { title: "x" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(deleteRichTextFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(richTextDocFn({ data: { id: "1" } } as never)).rejects.toBeInstanceOf(Error);
	});

	it("richTextDocFn returns null while the panel plugin is disabled", async () => {
		currentEmail = "admin@x.com";
		const created = await createRichTextFn({ data: { title: "Toggle" } });
		expect(created).not.toBeNull();
		await runtime.runPromise(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				yield* states.setEnabled(["rich-text.panel"], false);
			}),
		);
		try {
			await expect(richTextDocFn({ data: { id: created!.id } })).resolves.toBeNull();
		} finally {
			await runtime.runPromise(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(["rich-text.panel"], true);
				}),
			);
		}
		await expect(richTextDocFn({ data: { id: created!.id } })).resolves.toMatchObject({
			id: created!.id,
		});
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stubRichTexts = RichTexts.of({
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminGet: () => Effect.fail({ _tag: "Other" }),
			adminCreate: () => Effect.fail({ _tag: "Other" }),
			adminUpdate: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			getById: () => Effect.fail({ _tag: "Other" }),
		} as unknown as RichTexts["Service"]);
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
				Layer.succeed(RichTexts, stubRichTexts),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			// The stub fails with an untranslatable tag — the fns' catch
			// blocks only map the handled domain errors, so it propagates.
			await expect(createRichTextFn({ data: {} })).rejects.toMatchObject({ _tag: "Other" });
			await expect(updateRichTextFn({ data: { id: 1, title: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(deleteRichTextFn({ data: { id: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(listRichTextDocsFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(richTextDocFn({ data: { id: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("maps handled failures and rethrows plain errors", async () => {
		const stubRichTexts = RichTexts.of({
			adminList: () => Effect.succeed([]),
			adminGet: () => Effect.succeed(null),
			// adminCreate can legitimately resolve null (empty insert
			// returning) — the fn must pass that through as null. A
			// sentinel title fails with a non-domain error to exercise
			// the catch's rethrow path.
			adminCreate: (input: { title?: string }) =>
				input.title === "FAIL"
					? Effect.fail(new Error("plain create failure"))
					: Effect.succeed(null),
			adminUpdate: () => Effect.fail(new Error("plain update failure")),
			adminRemove: () => Effect.fail("plain delete failure"),
			getById: () => Effect.succeed(null),
		} as unknown as RichTexts["Service"]);
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
				Layer.succeed(RichTexts, stubRichTexts),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(createRichTextFn({ data: {} })).resolves.toBeNull();
			await expect(createRichTextFn({ data: { title: "FAIL" } })).rejects.toBeInstanceOf(Error);
			await expect(updateRichTextFn({ data: { id: 1, title: "x" } })).rejects.toBeInstanceOf(Error);
			const deleteError = await deleteRichTextFn({ data: { id: 1 } }).catch(
				(error: unknown) => error,
			);
			expect(deleteError).toBe("plain delete failure");
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
	it("richTextUsageFn returns referencers grouped by owner", async () => {
		currentEmail = "admin@x.com";
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* RichTextDeleteHooks;
				yield* hooks.register({
					id: "pages",
					usage: () => Effect.succeed([{ id: 3, title: "Home", path: "/" }]),
					cleanup: () => Effect.void,
				});
				yield* hooks.register({
					id: "empty",
					usage: () => Effect.succeed([]),
					cleanup: () => Effect.void,
				});
			}),
		);
		await expect(richTextUsageFn({ data: { id: 1 } })).resolves.toEqual([
			{ id: "pages", items: [{ id: 3, title: "Home", path: "/" }] },
		]);
	});

	it("deleteRichTextFn runs hook cleanup BEFORE removing when actionId is present", async () => {
		currentEmail = "admin@x.com";
		const created = await createRichTextFn({ data: { title: "Cascade" } });
		const seen: string[] = [];
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* RichTextDeleteHooks;
				const richTexts = yield* RichTexts;
				yield* hooks.register({
					id: "probe",
					usage: () => Effect.succeed([]),
					cleanup: (docId, actionId) =>
						Effect.gen(function* () {
							// The row must still exist at cleanup time — proof
							// the hook ran before adminRemove.
							const row = yield* richTexts.getById(docId);
							seen.push(`${actionId}:${row === null ? "gone" : "present"}`);
						}),
				});
			}),
		);
		expect(await deleteRichTextFn({ data: { id: created!.id, actionId: "probe.act" } })).toBe(true);
		expect(seen).toEqual(["probe.act:present"]);
		await expect(richTextDocFn({ data: { id: created!.id } })).resolves.toBeNull();
	});

	it("deleteRichTextFn aborts before removing when cleanup fails", async () => {
		currentEmail = "admin@x.com";
		const created = await createRichTextFn({ data: { title: "Blocked" } });
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* RichTextDeleteHooks;
				yield* hooks.register({
					id: "failer",
					usage: () => Effect.succeed([]),
					cleanup: () => Effect.fail(new Error("cleanup boom")),
				});
			}),
		);
		await expect(
			deleteRichTextFn({ data: { id: created!.id, actionId: "failer.act" } }),
		).rejects.toThrow("cleanup boom");
		// The row survives — cleanup ran before adminRemove.
		await expect(richTextDocFn({ data: { id: created!.id } })).resolves.toMatchObject({
			id: created!.id,
		});
		// Plain deletes (no actionId) skip cleanup entirely.
		expect(await deleteRichTextFn({ data: { id: created!.id } })).toBe(true);
	});

	it("richTextUsageFn propagates hook failures (hidden referencers are worse)", async () => {
		currentEmail = "admin@x.com";
		await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* RichTextDeleteHooks;
				yield* hooks.register({
					id: "bad",
					usage: () => Effect.fail(new Error("usage boom")),
					cleanup: () => Effect.void,
				});
			}),
		);
		await expect(richTextUsageFn({ data: { id: 1 } })).rejects.toThrow("usage boom");
	});
});
