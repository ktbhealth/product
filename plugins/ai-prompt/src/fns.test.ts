import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	ensureSessionUser: vi.fn(),
	runAs: vi.fn(),
}));

// Same fake as the sibling plugin fns tests: handlers run as plain
// async fns; `runAs` executes the Effect for real against a runtime
// wired with the test Db so the service denial branches are hit.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const api = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return api;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (call?: { data?: unknown }) =>
				h({ ...(call ?? {}), data: validate ? validate(call?.data) : call?.data }),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: mocks.getSessionUser,
	ensureSessionUser: mocks.ensureSessionUser,
	runAs: mocks.runAs,
}));

import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, TenantForbidden } from "@ktb/tenant";

import { AI_PROMPT_TEST_DDL, AiPrompts, AiPromptsLive, type PromptCard } from "./index.ts";
import { promptsCreateFn, promptsListFn, promptsRemoveFn, promptsUpdateFn } from "./fns.ts";

const ADMIN_EMAIL = "admin@x.com";
const MEMBER_EMAIL = "doc@clinic.com";

type User = { id: string; email: string };

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(AiPromptsLive.pipe(Layer.provide(infra)));
};

/** runAs executes the Effect for real, providing the caller identity
 * the way the host composition root would. */
const wireRunAs =
	(runtime: ManagedRuntime.ManagedRuntime<AiPrompts, never>, role: "admin" | "member" = "admin") =>
	async (user: User, effect: Effect.Effect<unknown, unknown, unknown>) =>
		runtime.runPromise(
			effect.pipe(
				Effect.provideService(Principal, { userId: user.id, email: user.email }),
				Effect.provideService(Tenant, {
					id: 7,
					kind: "clinic",
					slug: "clinic-7",
					role,
				}),
			) as Effect.Effect<unknown, unknown, never>,
		);

describe("ai-prompt fns", () => {
	let db: DbClient;
	let runtime: ManagedRuntime.ManagedRuntime<AiPrompts, never>;

	beforeEach(async () => {
		vi.clearAllMocks();
		db = makeDb(makeD1(AI_PROMPT_TEST_DDL));
		await db.insert(groups).values({
			id: 7,
			name: "Clinic",
			slug: "clinic-7",
			kind: "clinic",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		runtime = makeRuntime(db);
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.ensureSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.runAs.mockImplementation(wireRunAs(runtime));
	});

	it("promptsListFn returns [] for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(promptsListFn()).resolves.toEqual([]);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("promptsListFn lists platform prompts for admins, name filter included", async () => {
		await promptsCreateFn({ data: { name: "fn.prompt", template: "t" } });
		const rows = (await promptsListFn()) as readonly PromptCard[];
		expect(rows.map((r) => r.name)).toContain("fn.prompt");
		const named = (await promptsListFn({ data: { name: "fn.prompt" } })) as readonly PromptCard[];
		expect(named.map((r) => r.name)).toEqual(["fn.prompt"]);
		// Empty name is treated as no filter.
		const blank = (await promptsListFn({ data: { name: "" } })) as readonly PromptCard[];
		expect(blank.length).toBe(rows.length);
	});

	it("promptsListFn degrades to [] on denial", async () => {
		mocks.getSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		await expect(promptsListFn()).resolves.toEqual([]);
	});

	it("promptsCreateFn returns the card and applies defaults", async () => {
		const result = (await promptsCreateFn({
			data: {
				name: "created.prompt",
				template: "say {thing}",
				version: 3,
				locale: "pt-BR",
				variables: [{ name: "thing", required: true, description: "input" }],
				modelHint: "kind:chat",
				isSystem: true,
				isDefault: true,
			},
		})) as { ok: true; data: PromptCard };
		expect(result.ok).toBe(true);
		expect(result.data.name).toBe("created.prompt");
		expect(result.data.scope).toBe("platform");
		expect(result.data.version).toBe(3);
		expect(result.data.locale).toBe("pt-BR");
		expect(result.data.variables).toEqual([
			{ name: "thing", required: true, description: "input" },
		]);
		expect(result.data.modelHint).toBe("kind:chat");
		expect(result.data.isSystem).toBe(true);
		expect(result.data.isDefault).toBe(true);
	});

	it("promptsCreateFn maps service denials to { ok: false }", async () => {
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		mocks.runAs.mockImplementation(wireRunAs(runtime, "member"));
		const result = await promptsCreateFn({ data: { name: "x", template: "t" } });
		expect(result).toEqual({ ok: false });
	});

	it("validators reject malformed payloads", async () => {
		await expect(promptsCreateFn({ data: { name: "", template: "t" } })).rejects.toThrow();
		await expect(promptsCreateFn({ data: { name: "x" } })).rejects.toThrow();
		await expect(promptsUpdateFn({ data: { id: "nope" } })).rejects.toThrow();
		await expect(promptsRemoveFn({ data: { id: "x" } })).rejects.toThrow();
		await expect(promptsListFn({ data: { name: 42 } })).rejects.toThrow();
	});

	it("update/remove round-trip through the service", async () => {
		const created = (await promptsCreateFn({
			data: { name: "round.prompt", template: "v1" },
		})) as { ok: true; data: PromptCard };
		const id = created.data.id;

		const updated = (await promptsUpdateFn({
			data: {
				id,
				template: "v2",
				variables: [{ name: "v" }],
				modelHint: null,
				isSystem: true,
				isDefault: true,
				enabled: false,
			},
		})) as { ok: true; data: PromptCard };
		expect(updated.ok).toBe(true);
		expect(updated.data.template).toBe("v2");
		expect(updated.data.enabled).toBe(false);

		// Sparse update — every optional field absent.
		const sparse = (await promptsUpdateFn({ data: { id } })) as {
			ok: true;
			data: PromptCard;
		};
		expect(sparse.data.template).toBe("v2");

		const removed = (await promptsRemoveFn({ data: { id } })) as {
			ok: true;
			data: null;
		};
		expect(removed).toEqual({ ok: true, data: null });
	});

	it("TenantForbidden denials also collapse to { ok: false }", async () => {
		// Platform scope can only raise Forbidden in practice; stub the
		// service inside runAs to prove the collapse covers TenantForbidden.
		const tenantDenied = {
			create: () =>
				Effect.fail(
					new TenantForbidden({ path: "ai-prompt.admin", role: null, required: "admin" }),
				),
		} as unknown as AiPrompts["Service"];
		mocks.runAs.mockImplementationOnce(
			async (_user: User, effect: Effect.Effect<unknown, unknown, unknown>) =>
				Effect.runPromise(
					effect.pipe(Effect.provideService(AiPrompts, tenantDenied)) as Effect.Effect<
						unknown,
						unknown,
						never
					>,
				),
		);
		await expect(promptsCreateFn({ data: { name: "x", template: "t" } })).resolves.toEqual({
			ok: false,
		});
	});

	it("missing ids and denials degrade to { ok: false }", async () => {
		expect(await promptsUpdateFn({ data: { id: 999_999, template: "x" } })).toEqual({
			ok: false,
		});
		expect(await promptsRemoveFn({ data: { id: 999_999 } })).toEqual({ ok: false });
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		mocks.runAs.mockImplementation(wireRunAs(runtime, "member"));
		expect(await promptsUpdateFn({ data: { id: 1, template: "x" } })).toEqual({ ok: false });
		expect(await promptsRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });
	});
});
