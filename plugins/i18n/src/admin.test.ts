import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";
import { PlatformAdmin, type PlatformAdminShape } from "@ktb/platform";

import { I18nAdmin, I18nAdminLive, I18nValidationError } from "./admin.ts";
import { I18N_TEST_DDL, i18nMessages } from "./index.ts";
import { I18nRuntimeLive } from "./runtime.ts";

let db: DbClient;

const adminGate: PlatformAdminShape = {
	isAdmin: () => Effect.succeed(true),
	requireAdmin: () => Effect.void,
};
const denyGate: PlatformAdminShape = {
	isAdmin: () => Effect.succeed(false),
	requireAdmin: () => Effect.fail(new Forbidden({ path: "platform.admin" })),
};

const makeRuntime = (gate: PlatformAdminShape = adminGate) =>
	ManagedRuntime.make(
		I18nAdminLive.pipe(
			Layer.provide(I18nRuntimeLive),
			Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, gate))),
		),
	);

const ID = {
	namespace: "app",
	key: "welcome",
	locale: "en",
	scope: "global" as const,
	scopeId: "",
};

beforeAll(() => {
	db = makeDb(makeD1(I18N_TEST_DDL));
});

describe("I18nAdmin", () => {
	it("saveDraft stages draft_value without touching live value", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...ID, value: "Welcome {name}" });
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toBe("");
		expect(rows[0]?.draftValue).toBe("Welcome {name}");
		expect(rows[0]?.status).toBe("draft");
	});

	it("rejects markup in text messages", async () => {
		const rt = makeRuntime();
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.saveDraft({ ...ID, key: "bad", value: "<b>hi</b>" }).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(I18nValidationError);
	});

	it("publish moves draft_value live and bumps version", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.publish(ID);
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows[0]?.value).toBe("Welcome {name}");
		expect(rows[0]?.draftValue).toBeNull();
		expect(rows[0]?.status).toBe("published");
		expect(rows[0]?.version).toBe(2);
	});

	it("discardDraft deletes never-published rows", async () => {
		const rt = makeRuntime();
		await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				yield* admin.saveDraft({ ...ID, key: "temp", locale: "pt-BR", value: "Olá" });
				yield* admin.discardDraft({ ...ID, key: "temp", locale: "pt-BR" });
			}),
		);
		const rows = await db.select().from(i18nMessages);
		expect(rows.find((r) => r.key === "temp")).toBeUndefined();
	});

	it("denies writes when neither grant nor admin gate passes", async () => {
		const rt = makeRuntime(denyGate);
		const err = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return yield* admin.saveDraft({ ...ID, key: "nope", value: "x" }).pipe(Effect.flip);
			}),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});

	it("namespaces + locales list for the panel", async () => {
		const rt = makeRuntime();
		const out = await rt.runPromise(
			Effect.gen(function* () {
				const admin = yield* I18nAdmin;
				return {
					namespaces: yield* admin.namespaces(),
					locales: yield* admin.locales(),
				};
			}),
		);
		expect(out.namespaces.map((n) => n.namespace)).toContain("app");
	});
});
