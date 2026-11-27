import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Audit } from "@ktb/audit";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { groups } from "@ktb/db/schema";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type TenantRole } from "@ktb/tenant";

import { AiPrompts, AiPromptsLive } from "./index.ts";
import {
	getPromptById,
	getPromptVersion,
	insertPrompt,
	listPromptVersions,
	listPrompts,
	updatePrompt,
} from "./prompts.ts";

const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (
	db: DbClient,
	extra: Layer.Layer<never, never, never> | Layer.Layer<Audit, never, never> = Layer.empty,
) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(
		Layer.mergeAll(AiPromptsLive.pipe(Layer.provide(infra)), infra, extra) as Layer.Layer<
			unknown,
			never,
			never
		>,
	);
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<unknown, never>,
	effect: Effect.Effect<A, E, unknown>,
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
		db = makeDb(makeTestD1());
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
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.create({ name: "x", template: "  " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
	});

	it("get returns the card for an existing row; unknown ids fail update/remove", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "get.me", template: "t" })),
			asAdmin,
		);
		const got = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.get(card.id)),
			asAdmin,
		);
		expect(got?.name).toBe("get.me");
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.update({ id: 99999, template: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.remove(99999)),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id, template: " " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await rt.dispose();
	});

	it("list defaults to platform scope, filters by name, and tenant scope without tenantId degrades", async () => {
		const rt = makeRuntime(db);
		const all = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list()),
			asAdmin,
		);
		expect(all.length).toBeGreaterThan(0);
		const named = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "anamnesis.extract" })),
			asAdmin,
		);
		expect(named.every((c) => c.name === "anamnesis.extract")).toBe(true);
		// scope "tenant" without tenantId falls back to platform — the
		// write then requires a platform admin.
		const degraded = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ scope: "tenant", name: "deg.prompt", template: "t" }),
			),
			asAdmin,
		);
		expect(degraded.scope).toBe("platform");
		// Members read tenant scope (requireTenantRole "member" arm).
		const memberList = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: TENANT_ID })),
			asMember,
		);
		expect(memberList.map((c) => c.name)).toContain("clinic.prompt");
		// Locale request with no exact match falls back to the neutral row.
		const neutralFallback = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "eval.judge", locale: "es" })),
			asAdmin,
		);
		expect(neutralFallback?.locale).toBe("");
		// Tenant mismatch via scope id.
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: 8 })),
				asMember,
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ role: null, email: "nobody@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		await rt.dispose();
	});

	it("create honors locale/modelHint/isDefault pins", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({
					name: "hinted.prompt",
					template: "t",
					locale: "es",
					modelHint: "judge-kind",
					isDefault: true,
				}),
			),
			asAdmin,
		);
		expect(card).toMatchObject({ locale: "es", modelHint: "judge-kind", isDefault: true });
		await rt.dispose();
	});

	it("update applies every mutable field", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "upd.prompt", template: "old" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.update({
					id: card.id,
					template: "new",
					variables: [{ name: "x", required: true, description: "d" }],
					modelHint: "hint",
					isSystem: true,
					isDefault: true,
					enabled: true,
				}),
			),
			asAdmin,
		);
		expect(updated).toMatchObject({
			template: "new",
			variables: [{ name: "x", required: true, description: "d" }],
			modelHint: "hint",
			isSystem: true,
			isDefault: true,
			enabled: true,
		});
		await rt.dispose();
	});

	it("resolve covers pin misses, locale fallback arms and blank names", async () => {
		const rt = makeRuntime(db);
		// Version pin that matches nothing → null.
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "eval.judge", version: 99 })),
				asAdmin,
			),
		).toBeNull();
		// Locale with no exact and no neutral row → null (es-only prompt).
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "es.only", template: "t", locale: "es" })),
			asAdmin,
		);
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "es.only", locale: "pt-BR" })),
				asAdmin,
			),
		).toBeNull();
		// No locale requested and no neutral row → newest localized wins.
		const anyLocale = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "es.only" })),
			asAdmin,
		);
		expect(anyLocale?.locale).toBe("es");
		// Blank name → null without touching the db.
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "   " })),
				asAdmin,
			),
		).toBeNull();
		await rt.dispose();
	});

	it("records audit entries when the Audit service is bound", async () => {
		const entries: { action: string; tenantId?: unknown }[] = [];
		const audit = Layer.succeed(Audit, {
			record: (entry: { action: string; tenantId?: unknown }) =>
				Effect.sync(() => {
					entries.push(entry);
				}),
		} as never);
		const rt = makeRuntime(db, audit);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "aud.p", template: "t" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "aud.t",
					template: "t",
				}),
			),
			asTenantAdmin,
		);
		// resolve also audits.
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "aud.p" })),
			{ role: null, email: "sys@x.com" },
		);
		const actions = entries.map((e) => e.action);
		expect(actions).toContain("ai-prompt.create");
		expect(actions).toContain("ai-prompt.resolve");
		expect(entries.find((e) => e.tenantId === TENANT_ID)).toBeDefined();
		await rt.dispose();
	});

	it("parses malformed and non-array variables as []", async () => {
		const base = {
			scope: "platform",
			tenantId: null,
			name: "bad.vars",
			version: 1,
			locale: "",
			template: "t",
			modelHint: null,
			isSystem: false,
			isDefault: false,
		};
		await insertPrompt(db, { ...base, variables: "{oops" });
		await insertPrompt(db, { ...base, version: 2, variables: '{"a":1}' });
		await insertPrompt(db, {
			...base,
			version: 3,
			variables: '[{"name":"ok"},{"noName":1},5,"str"]',
		});
		const rt = makeRuntime(db);
		const rows = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "bad.vars" })),
			asAdmin,
		);
		expect(rows.find((c) => c.version === 1)?.variables).toEqual([]);
		expect(rows.find((c) => c.version === 2)?.variables).toEqual([]);
		expect(rows.find((c) => c.version === 3)?.variables).toEqual([{ name: "ok" }]);
		await rt.dispose();
	});

	it("repo functions round-trip rows directly", async () => {
		const row = await insertPrompt(db, {
			scope: "platform",
			tenantId: null,
			name: "repo.prompt",
			version: 1,
			locale: "",
			template: "t",
			variables: null,
			modelHint: null,
			isSystem: false,
			isDefault: false,
		});
		expect(row.id).toBeGreaterThan(0);
		expect((await getPromptById(db, row.id))?.name).toBe("repo.prompt");
		expect(await getPromptById(db, 999999)).toBeNull();
		expect((await listPromptVersions(db, "platform", "repo.prompt")).map((r) => r.id)).toEqual([
			row.id,
		]);
		expect((await listPrompts(db, "platform")).map((r) => r.name)).toContain("repo.prompt");
		expect(await getPromptVersion(db, "platform", "repo.prompt", 1, "")).not.toBeNull();
		expect(await getPromptVersion(db, "platform", "repo.prompt", 9, "")).toBeNull();
		await updatePrompt(db, row.id, { template: "t2", enabled: 0 });
		expect((await getPromptById(db, row.id))?.enabled).toBe(0);
	});
});
