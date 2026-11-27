import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { type TemplateKind } from "./kinds.ts";
import { templates } from "./schema.ts";
import {
	InvalidTemplateName,
	InvalidTemplatePayload,
	TemplateKinds,
	TemplateKindsLive,
	Templates,
	TemplatesLive,
	TemplateNameTaken,
	TemplateNotFound,
	UnknownTemplateKind,
} from "./service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test kind: wraps the source in `{wrapped: …}` on serialize and
 * unwraps on deserialize; validate requires the `wrapped` key. */
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
	preview: () => Effect.succeed("preview"),
};

const otherKind: TemplateKind = { ...testKind, kind: "other-kind", label: "Other" };

describe("TemplatesLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Templates | TemplateKinds, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(async () => {
		db = makeDb(makeTestD1());
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(
				PlatformAdmin,
				makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"), {
					// "admin-2" is an RBAC-granted admin with no email on the
					// principal — exercises the createdBy null fallback.
					grantFor: (userId) => Effect.succeed(userId === "admin-2"),
				}),
			),
		);
		// Production wiring: TemplatesLive consumes the shared
		// TemplateKinds registry which stays visible to callers.
		runtime = ManagedRuntime.make(
			TemplatesLive.pipe(Layer.provideMerge(TemplateKindsLive), Layer.provide(deps)) as Layer.Layer<
				Templates | TemplateKinds,
				never,
				never
			>,
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* TemplateKinds;
				yield* kinds.register(testKind);
				yield* kinds.register(otherKind);
			}),
		);
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Templates | TemplateKinds>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(
		f: (p: Templates["Service"]) => Effect.Effect<A, E, Templates | TemplateKinds>,
	) => Effect.flatMap(Templates, f);

	const admin = <A, E>(
		f: (p: Templates["Service"]) => Effect.Effect<A, E, Templates | TemplateKinds>,
	) => asUser("admin-1", call(f), "admin@x.com");

	it("save serializes the source through the kind and stores createdBy", async () => {
		const doc = await admin((p) =>
			p.save({ kind: "test-kind", name: "  snap-1  ", source: { a: 1 } }),
		);
		expect(doc).not.toBeNull();
		expect(doc!.kind).toBe("test-kind");
		expect(doc!.name).toBe("snap-1");
		expect(doc!.payload).toEqual({ wrapped: { a: 1 } });
		expect(doc!.createdBy).toBe("admin@x.com");
		expect(doc!.description).toBeNull();
	});

	it("save accepts a ready payload and honors description", async () => {
		const doc = await admin((p) =>
			p.save({
				kind: "test-kind",
				name: "snap-2",
				description: "  notes  ",
				payload: { wrapped: "raw" },
			}),
		);
		expect(doc!.description).toBe("notes");
		expect(doc!.payload).toEqual({ wrapped: "raw" });
	});

	it("save stores a blank description as null", async () => {
		const doc = await admin((p) =>
			p.save({
				kind: "test-kind",
				name: "snap-blank",
				description: "   ",
				payload: { wrapped: 1 },
			}),
		);
		expect(doc!.description).toBeNull();
	});

	it("save without source or payload serializes null through the kind", async () => {
		const doc = await admin((p) => p.save({ kind: "test-kind", name: "no-source" }));
		// testKind.serialize wraps its input — null source lands as
		// {wrapped: null} in the stored payload.
		expect(doc!.payload).toEqual({ wrapped: null });
	});

	it("save rejects payloads that serialize to undefined", async () => {
		const undefKind: TemplateKind = {
			kind: "undef-kind",
			label: "Undef",
			serialize: () => Effect.succeed(undefined),
			deserialize: (p) => Effect.succeed(p),
			validate: () => Effect.succeed([]),
		};
		await runtime.runPromise(Effect.flatMap(TemplateKinds, (kinds) => kinds.register(undefKind)));
		await expect(
			admin((p) => p.save({ kind: "undef-kind", name: "undef", source: {} })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
	});

	it("save records a null createdBy when the principal has no email", async () => {
		const doc = await asUser(
			"admin-2",
			call((p) => p.save({ kind: "test-kind", name: "no-email", payload: { wrapped: 1 } })),
		);
		expect(doc!.createdBy).toBeNull();
	});

	it("save rejects blank names, duplicate names per kind and bad payloads", async () => {
		await expect(
			admin((p) => p.save({ kind: "test-kind", name: "   ", payload: { wrapped: 1 } })),
		).rejects.toBeInstanceOf(InvalidTemplateName);
		await expect(
			admin((p) => p.save({ kind: "test-kind", name: "snap-1", payload: { wrapped: 1 } })),
		).rejects.toBeInstanceOf(TemplateNameTaken);
		// Same name under a different kind is fine.
		const other = await admin((p) =>
			p.save({ kind: "other-kind", name: "snap-1", payload: { wrapped: 1 } }),
		);
		expect(other!.kind).toBe("other-kind");
		await expect(
			admin((p) => p.save({ kind: "test-kind", name: "bad", payload: { nope: true } })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
		// JSON-unsafe payloads (BigInt) fail the storable-payload gate.
		await expect(
			admin((p) => p.save({ kind: "test-kind", name: "bad2", payload: { wrapped: 1n } })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
		await expect(
			admin((p) => p.save({ kind: "ghost-kind", name: "x", payload: {} })),
		).rejects.toBeInstanceOf(UnknownTemplateKind);
	});

	it("save maps kind serialize/validate failures onto InvalidTemplatePayload", async () => {
		const failing: TemplateKind = {
			kind: "failing-kind",
			label: "Failing",
			serialize: () => Effect.fail(new Error("boom")),
			deserialize: (p) => Effect.succeed(p),
			validate: () => Effect.succeed([]),
		};
		await runtime.runPromise(Effect.flatMap(TemplateKinds, (kinds) => kinds.register(failing)));
		await expect(
			admin((p) => p.save({ kind: "failing-kind", name: "x", source: {} })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
		const badValidate: TemplateKind = {
			kind: "bad-validate-kind",
			label: "Bad validate",
			serialize: (s) => Effect.succeed(s),
			deserialize: (p) => Effect.succeed(p),
			validate: () => Effect.fail(new Error("validator boom")),
		};
		await runtime.runPromise(Effect.flatMap(TemplateKinds, (kinds) => kinds.register(badValidate)));
		await expect(
			admin((p) => p.save({ kind: "bad-validate-kind", name: "y", source: {} })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
	});

	it("adminList returns metas ordered by updatedAt desc (no payload)", async () => {
		const first = await admin((p) =>
			p.save({ kind: "test-kind", name: "first", payload: { wrapped: 1 } }),
		);
		await sleep(5);
		const second = await admin((p) =>
			p.save({ kind: "test-kind", name: "second", payload: { wrapped: 2 } }),
		);
		const rows = await admin((p) => p.adminList());
		expect(rows.map((r) => r.id)).toContain(first!.id);
		expect(rows.map((r) => r.id)).toContain(second!.id);
		expect(rows.findIndex((r) => r.id === second!.id)).toBeLessThan(
			rows.findIndex((r) => r.id === first!.id),
		);
		expect(rows[0]).not.toHaveProperty("payload");
		expect(rows[0]).toHaveProperty("kind");
		expect(rows[0]).toHaveProperty("createdBy");
	});

	it("listByKind filters by kind and rejects unknown kinds", async () => {
		const mine = await admin((p) => p.listByKind("test-kind"));
		expect(mine.length).toBeGreaterThan(0);
		expect(mine.every((r) => r.kind === "test-kind")).toBe(true);
		const other = await admin((p) => p.listByKind("other-kind"));
		expect(other.every((r) => r.kind === "other-kind")).toBe(true);
		await expect(admin((p) => p.listByKind("ghost-kind"))).rejects.toBeInstanceOf(
			UnknownTemplateKind,
		);
	});

	it("adminGet returns the doc; getById is a public read", async () => {
		const created = await admin((p) =>
			p.save({ kind: "test-kind", name: "get-me", payload: { wrapped: "v" } }),
		);
		const doc = await admin((p) => p.adminGet(created!.id));
		expect(doc!.payload).toEqual({ wrapped: "v" });
		// Public read needs no principal.
		const publicDoc = await asUser(
			null,
			call((p) => p.getById(created!.id)),
		);
		expect(publicDoc!.name).toBe("get-me");
		await expect(admin((p) => p.adminGet(999999))).resolves.toBeNull();
		await expect(
			asUser(
				null,
				call((p) => p.getById(999999)),
			),
		).resolves.toBeNull();
	});

	it("adminUpdate renames, clears description and swaps payload", async () => {
		const created = await admin((p) =>
			p.save({ kind: "test-kind", name: "upd", description: "d", payload: { wrapped: 1 } }),
		);
		const renamed = await admin((p) =>
			p.adminUpdate(created!.id, { name: "upd-2", description: "   " }),
		);
		expect(renamed.name).toBe("upd-2");
		expect(renamed.description).toBeNull();
		expect(renamed.payload).toEqual({ wrapped: 1 });
		const repayloaded = await admin((p) =>
			p.adminUpdate(created!.id, { payload: { wrapped: "new" } }),
		);
		expect(repayloaded.payload).toEqual({ wrapped: "new" });
		await expect(admin((p) => p.adminUpdate(created!.id, { name: "   " }))).rejects.toBeInstanceOf(
			InvalidTemplateName,
		);
		await expect(
			admin((p) => p.adminUpdate(created!.id, { payload: { nope: 1 } })),
		).rejects.toBeInstanceOf(InvalidTemplatePayload);
		await expect(
			admin((p) => p.adminUpdate(created!.id, { name: "first" })),
		).rejects.toBeInstanceOf(TemplateNameTaken);
		await expect(admin((p) => p.adminUpdate(999999, { name: "x" }))).rejects.toBeInstanceOf(
			TemplateNotFound,
		);
	});

	it("adminUpdate on a row whose kind vanished rejects payload writes but allows meta", async () => {
		const ghost = await admin((p) =>
			p.save({ kind: "other-kind", name: "ghost", payload: { wrapped: 1 } }),
		);
		// Simulate the kind owner disappearing: overwrite the row's kind
		// directly (bypasses the service).
		await db.update(templates).set({ kind: "ghost-kind" }).where(eq(templates.id, ghost!.id));
		const meta = await admin((p) => p.adminUpdate(ghost!.id, { name: "ghost-2" }));
		expect(meta.name).toBe("ghost-2");
		await expect(
			admin((p) => p.adminUpdate(ghost!.id, { payload: { wrapped: 1 } })),
		).rejects.toBeInstanceOf(UnknownTemplateKind);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const created = await admin((p) =>
			p.save({ kind: "test-kind", name: "bye", payload: { wrapped: 1 } }),
		);
		await admin((p) => p.adminRemove(created!.id));
		await expect(admin((p) => p.adminRemove(created!.id))).rejects.toBeInstanceOf(TemplateNotFound);
	});

	it("instantiate deserializes the payload into the kind's source form", async () => {
		const created = await admin((p) =>
			p.save({ kind: "test-kind", name: "inst", source: { deep: [1, 2] } }),
		);
		const instance = await admin((p) => p.instantiate(created!.id));
		expect(instance).toEqual({ kind: "test-kind", source: { deep: [1, 2] } });
		await expect(admin((p) => p.instantiate(999999))).resolves.toBeNull();
	});

	it("instantiate resolves null for rows whose kind is unregistered", async () => {
		const created = await admin((p) =>
			p.save({ kind: "other-kind", name: "inst-ghost", payload: { wrapped: 1 } }),
		);
		await db.update(templates).set({ kind: "ghost-kind" }).where(eq(templates.id, created!.id));
		await expect(admin((p) => p.instantiate(created!.id))).resolves.toBeNull();
	});

	it("instantiate maps deserialize failures onto InvalidTemplatePayload", async () => {
		const failingDeserialize: TemplateKind = {
			kind: "bad-deserialize-kind",
			label: "Bad deserialize",
			serialize: (s) => Effect.succeed(s),
			deserialize: () => Effect.fail(new Error("nope")),
			validate: () => Effect.succeed([]),
		};
		await runtime.runPromise(
			Effect.flatMap(TemplateKinds, (kinds) => kinds.register(failingDeserialize)),
		);
		const created = await admin((p) =>
			p.save({ kind: "bad-deserialize-kind", name: "inst-bad", payload: { any: 1 } }),
		);
		await expect(admin((p) => p.instantiate(created!.id))).rejects.toBeInstanceOf(
			InvalidTemplatePayload,
		);
	});

	it("admin methods reject non-admin principals", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				"u1",
				call((p) => p.save({ kind: "test-kind", name: "x", payload: { wrapped: 1 } })),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});
});
