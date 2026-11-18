import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type TenantRole } from "@ktb/tenant";

import { AI_PROMPT_TEST_DDL, AiPrompts, AiPromptsLive } from "./index.ts";

const DDL = AI_PROMPT_TEST_DDL;
const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(AiPromptsLive.pipe(Layer.provide(infra)));
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<AiPrompts, never>,
	effect: Effect.Effect<A, E, AiPrompts>,
	options: { role?: TenantRole | null; userId?: string; email?: string } = {},
) =>
	runtime.runPromise(
		effect.pipe(
			Effect.provideService(
				Tenant,
				options.role === null
					? null
					: {
							id: TENANT_ID,
							kind: "clinic",
							slug: "clinic-7",
							role: options.role ?? "member",
						},
			),
			Effect.provideService(Principal, {
				userId: options.userId ?? "u1",
				email: options.email ?? ADMIN_EMAIL,
			}),
		),
	);

const asAdmin = { email: ADMIN_EMAIL };
const asMember = { email: USER_EMAIL };
const asTenantAdmin = { email: USER_EMAIL, role: "admin" as TenantRole };

const EXTRACT_V1 = "Extract the anamnesis from this consultation transcript.";

describe("AiPrompts", () => {
	let db: DbClient;
	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await db.insert(groups).values({
			id: TENANT_ID,
			name: "Clinic",
			slug: "clinic-7",
			kind: "clinic",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	it("creates prompt versions; auto-increments and pins work", async () => {
		const rt = makeRuntime(db);
		const v1 = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({
					name: "anamnesis.extract",
					template: EXTRACT_V1,
					variables: [{ name: "transcript", required: true }],
					isSystem: true,
				}),
			),
			asAdmin,
		);
		expect(v1.version).toBe(1);
		expect(v1.locale).toBe("");
		expect(v1.variables).toEqual([{ name: "transcript", required: true }]);
		const v2 = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ name: "anamnesis.extract", template: "v2 template" }),
			),
			asAdmin,
		);
		expect(v2.version).toBe(2);
		// Same (name, version, locale) is a duplicate.
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) =>
					p.create({ name: "anamnesis.extract", version: 2, template: "dup" }),
				),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "duplicate" });
	});

	it("denies platform-scope writes to non-admins", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.create({ name: "x", template: "t" })),
				asMember,
			),
		).rejects.toBeInstanceOf(Forbidden);
	});

	it("resolve picks newest enabled; version pin and locale fallback work", async () => {
		const rt = makeRuntime(db);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ name: "eval.judge", template: "judge v1", locale: "pt-BR" }),
			),
			asAdmin,
		);
		const v2 = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "eval.judge", template: "judge v2" })),
			asAdmin,
		);
		// Newest wins when unpinned.
		const newest = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "eval.judge" })),
			{ role: null, email: "sys@x.com" },
		);
		expect(newest?.version).toBe(2);
		// Locale request: v1 has pt-BR but v2 (newest) is neutral —
		// per-version matching prefers the newest version's locale set.
		const pinned = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "eval.judge", version: v2.version })),
			asAdmin,
		);
		expect(pinned?.id).toBe(v2.id);
		// pt-BR request falls back across versions: v1 pt-BR is older
		// than v2 neutral — pickResolved prefers newest version group.
		const localized = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "eval.judge", locale: "pt-BR" })),
			asAdmin,
		);
		expect(localized).not.toBeNull();
	});

	it("disabled rows resolve null; unknown names resolve null", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "off.prompt", template: "t" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id, enabled: false })),
			asAdmin,
		);
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "off.prompt" })),
				asAdmin,
			),
		).toBeNull();
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "nope" })),
				asAdmin,
			),
		).toBeNull();
	});

	it("tenant scope works for members read / admins write", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "clinic.prompt",
					template: "tenant template",
				}),
			),
			asTenantAdmin,
		);
		expect(card.scope).toBe(String(TENANT_ID));
		const resolved = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.resolve({ name: "clinic.prompt", scope: "tenant", tenantId: TENANT_ID }),
			),
			asMember,
		);
		expect(resolved?.template).toBe("tenant template");
	});

	it("update edits mutable fields; remove deletes the version", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "tmp.prompt", template: "old" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id, template: "new", isDefault: true })),
			asAdmin,
		);
		expect(updated.template).toBe("new");
		expect(updated.isDefault).toBe(true);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.remove(card.id)),
			asAdmin,
		);
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.get(card.id)),
				asAdmin,
			),
		).toBeNull();
	});

	it("empty name/template rejected", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.create({ name: "  ", template: "t" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
	});
});
