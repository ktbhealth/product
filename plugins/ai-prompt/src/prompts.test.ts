import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Audit } from "@ktb/audit";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, TenantForbidden, type TenantRole } from "@ktb/tenant";

import {
	AI_PROMPT_TEST_DDL,
	AiPrompts,
	AiPromptsLive,
	aiPromptPanelPlugin,
	PromptError,
	type PromptCard,
} from "./index.ts";
import { aiPrompt } from "./schema.ts";

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

describe("AiPrompts listing, get and edge cases", () => {
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

	it("list returns platform cards; the name filter narrows to one family", async () => {
		const rt = makeRuntime(db);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "list.alpha", template: "a" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ name: "list.beta", template: "b", locale: "pt-BR" }),
			),
			asAdmin,
		);
		const all = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list()),
			asAdmin,
		);
		expect(all.map((c) => c.name)).toEqual(expect.arrayContaining(["list.alpha", "list.beta"]));
		const named = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "list.alpha" })),
			asAdmin,
		);
		expect(named.map((c) => c.name)).toEqual(["list.alpha"]);
		// Explicit platform scope takes the same path.
		const scoped = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ scope: "platform" })),
			asAdmin,
		);
		expect(scoped.length).toBe(all.length);
	});

	it("tenant-scope list: members read, mismatched/absent tenants denied", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "tenant.list",
					template: "t",
				}),
			),
			asTenantAdmin,
		);
		const rows = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: TENANT_ID })),
			asMember,
		);
		expect(rows.map((c) => c.id)).toContain(card.id);
		// Bound tenant id does not match the requested scope.
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: 99 })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// No bound tenant at all.
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ role: null, email: "sys@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// Members cannot write tenant prompts.
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) =>
					p.create({
						scope: "tenant",
						tenantId: TENANT_ID,
						name: "tenant.denied",
						template: "t",
					}),
				),
				asMember,
			),
		).rejects.toBeInstanceOf(TenantForbidden);
	});

	it("get returns the card for an existing id", async () => {
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
	});

	it("update/remove on a missing id fail not-found", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.update({ id: 999_999, template: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.remove(999_999)),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
	});

	it("update rejects a blank template and applies sparse/full patches", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "patch.me", template: "old" })),
			asAdmin,
		);
		await expect(
			run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id, template: "   " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		// Sparse update — every optional field absent.
		const sparse = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id })),
			asAdmin,
		);
		expect(sparse.template).toBe("old");
		// Full patch — every optional field present.
		const full = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.update({
					id: card.id,
					template: "new",
					variables: [{ name: "v", required: true }],
					modelHint: "kind:chat",
					isSystem: true,
					isDefault: true,
					enabled: false,
				}),
			),
			asAdmin,
		);
		expect(full.template).toBe("new");
		expect(full.variables).toEqual([{ name: "v", required: true }]);
		expect(full.modelHint).toBe("kind:chat");
		expect(full.isSystem).toBe(true);
		expect(full.isDefault).toBe(true);
		expect(full.enabled).toBe(false);
		const reenabled = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.update({ id: card.id, enabled: true })),
			asAdmin,
		);
		expect(reenabled.enabled).toBe(true);
	});

	it("resolve covers locale exact/fallback/null, version pin miss and blank name", async () => {
		const rt = makeRuntime(db);
		// Family with only a pt-BR row: exact hit, neutral fallback on a
		// different family, null when no locale matches, and the
		// no-locale "any version" fallback.
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ name: "loc.exact", template: "pt", locale: "pt-BR" }),
			),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.create({ name: "loc.neutral", template: "neutral" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiPrompts, (p) =>
				p.create({ name: "loc.miss", template: "pt-only", locale: "pt-BR" }),
			),
			asAdmin,
		);
		const exact = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "loc.exact", locale: "pt-BR" })),
			asAdmin,
		);
		expect(exact?.template).toBe("pt");
		const fallback = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "loc.neutral", locale: "pt-BR" })),
			asAdmin,
		);
		expect(fallback?.template).toBe("neutral");
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "loc.miss", locale: "es" })),
				asAdmin,
			),
		).toBeNull();
		// No locale requested and no neutral row → newest any-locale row.
		const anyLocale = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "loc.miss" })),
			asAdmin,
		);
		expect(anyLocale?.template).toBe("pt-only");
		// Pinned version that does not exist → null.
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "loc.exact", version: 42 })),
				asAdmin,
			),
		).toBeNull();
		// Blank name resolves null without touching the db.
		expect(
			await run(
				rt,
				Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "   " })),
				asAdmin,
			),
		).toBeNull();
	});

	it("parses stored variables leniently (non-array and invalid JSON → [])", async () => {
		const rt = makeRuntime(db);
		const now = new Date();
		await db.insert(aiPrompt).values([
			{
				scope: "platform",
				tenantId: null,
				name: "raw.badjson",
				version: 1,
				locale: "",
				template: "t",
				variables: "{not json",
				createdAt: now,
			},
			{
				scope: "platform",
				tenantId: null,
				name: "raw.object",
				version: 1,
				locale: "",
				template: "t",
				variables: '{"name":"x"}',
				createdAt: now,
			},
			{
				scope: "platform",
				tenantId: null,
				name: "raw.filtered",
				version: 1,
				locale: "",
				template: "t",
				variables: '[{"name":"ok"},42,"nope",null]',
				createdAt: now,
			},
		]);
		const cards = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "raw.filtered" })),
			asAdmin,
		);
		expect(cards[0]?.variables).toEqual([{ name: "ok" }]);
		const bad = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "raw.badjson" })),
			asAdmin,
		);
		expect(bad[0]?.variables).toEqual([]);
		const obj = await run(
			rt,
			Effect.flatMap(AiPrompts, (p) => p.list({ name: "raw.object" })),
			asAdmin,
		);
		expect(obj[0]?.variables).toEqual([]);
	});

	it("records audit entries for mutations and resolves when Audit is present", async () => {
		const entries: {
			action: string;
			targetType: string;
			targetId: number;
			tenantId: number | null;
			detail?: Record<string, unknown>;
		}[] = [];
		const auditStub = {
			record: (entry: (typeof entries)[number]) =>
				Effect.sync(() => {
					entries.push(entry);
				}),
		} as unknown as Audit["Service"];
		// serviceOption reads the ambient context — provide Audit per call.
		const withAudit = <A, E>(effect: Effect.Effect<A, E, AiPrompts>) =>
			effect.pipe(Effect.provideService(Audit, auditStub));
		const rt = makeRuntime(db);
		const platformCard = await run(
			rt,
			withAudit(
				Effect.flatMap(AiPrompts, (p) => p.create({ name: "audit.platform", template: "t" })),
			),
			asAdmin,
		);
		const tenantCard = await run(
			rt,
			withAudit(
				Effect.flatMap(AiPrompts, (p) =>
					p.create({
						scope: "tenant",
						tenantId: TENANT_ID,
						name: "audit.tenant",
						template: "t",
					}),
				),
			),
			asTenantAdmin,
		);
		await run(
			rt,
			withAudit(
				Effect.flatMap(AiPrompts, (p) => p.update({ id: platformCard.id, template: "t2" })),
			),
			asAdmin,
		);
		await run(
			rt,
			withAudit(Effect.flatMap(AiPrompts, (p) => p.resolve({ name: "audit.platform" }))),
			asAdmin,
		);
		await run(
			rt,
			withAudit(Effect.flatMap(AiPrompts, (p) => p.remove(tenantCard.id))),
			asTenantAdmin,
		);
		const actions = entries.map((e) => e.action);
		for (const expected of [
			"ai-prompt.create",
			"ai-prompt.update",
			"ai-prompt.resolve",
			"ai-prompt.remove",
		]) {
			expect(actions).toContain(expected);
		}
		// Platform rows record tenantId null; tenant rows the numeric id.
		const platformCreate = entries.find(
			(e) => e.action === "ai-prompt.create" && e.targetId === platformCard.id,
		);
		expect(platformCreate?.tenantId).toBeNull();
		const tenantCreate = entries.find(
			(e) => e.action === "ai-prompt.create" && e.targetId === tenantCard.id,
		);
		expect(tenantCreate?.tenantId).toBe(TENANT_ID);
		await rt.dispose();
	});
});

describe("aiPromptPanelPlugin page", () => {
	it("guard mirrors PlatformAdmin and loader lists platform prompts", async () => {
		const page = aiPromptPanelPlugin.panel!.pages![0]!;
		expect(page.path).toBe("/platform/ai/prompts");
		const rt = makeRuntime(makeDb(makeD1(DDL)));
		const gate = makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL));
		const provideCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provideService(Principal, { userId: "u1", email: ADMIN_EMAIL }),
				Effect.provideService(PlatformAdmin, gate),
				Effect.provideService(Tenant, {
					id: TENANT_ID,
					kind: "clinic",
					slug: "clinic-7",
					role: "member" as TenantRole,
				}),
			);
		const allowed = await rt.runPromise(provideCaller(page.guard!() as Effect.Effect<boolean>));
		expect(allowed).toBe(true);
		const loaded = await rt.runPromise(
			provideCaller(page.loader!() as Effect.Effect<readonly PromptCard[]>),
		);
		expect(Array.isArray(loaded)).toBe(true);
		// Non-admin callers: guard denies, loader degrades to [].
		const memberCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provideService(Principal, {
					userId: "u2",
					email: USER_EMAIL,
				}),
				Effect.provideService(PlatformAdmin, gate),
				Effect.provideService(Tenant, {
					id: TENANT_ID,
					kind: "clinic",
					slug: "clinic-7",
					role: "member" as TenantRole,
				}),
			);
		expect(await rt.runPromise(memberCaller(page.guard!() as Effect.Effect<boolean>))).toBe(false);
		expect(
			await rt.runPromise(memberCaller(page.loader!() as Effect.Effect<readonly PromptCard[]>)),
		).toEqual([]);
		await rt.dispose();
	});

	it("loader collapses PromptError, TenantForbidden and Forbidden to []", async () => {
		const page = aiPromptPanelPlugin.panel!.pages![0]!;
		const loader = page.loader!() as Effect.Effect<readonly PromptCard[]>;
		const stub = (err: PromptError | TenantForbidden | Forbidden) =>
			({ list: () => Effect.fail(err) }) as unknown as AiPrompts["Service"];
		for (const err of [
			new PromptError({ reason: "not-found" }),
			new TenantForbidden({ path: "ai-prompt.member", role: null, required: "member" }),
			new Forbidden({ path: "platform.admin" }),
		]) {
			const out = await Effect.runPromise(loader.pipe(Effect.provideService(AiPrompts, stub(err))));
			expect(out).toEqual([]);
		}
	});
});
