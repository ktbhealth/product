import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { eq } from "drizzle-orm";

import { Accounts, type CreateAccountResult } from "@ktb/auth";
import { DoctorProfiles, PatientProfiles } from "@ktb/server-fns";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import {
	accountExists,
	consumeInvite,
	findInvite,
	hashInviteToken,
	INVITE_DESTINATIONS,
	INVITE_KINDS,
	INVITE_TTL_MS,
	inviteAcceptPath,
	InviteRejected,
	Invites,
	InvitesLive,
	invitesRoutesPlugin,
	invitesServicesPlugin,
	invitesTablesPlugin,
	issueInvite,
	newInviteToken,
	normalizeEmail,
	plugins,
} from "./index.ts";
import { inviteTokens } from "./schema.ts";

// taken@ktb.test already has an account; every other address is new.
const DDL = `
INSERT INTO "user" (id, email, name, created_at, updated_at) VALUES ('u-taken', 'taken@ktb.test', 'u-taken', 0, 0);
`;

const freshDb = () => makeDb(makeTestD1(DDL));

const NOW = new Date("2026-03-01T12:00:00.000Z");
const secretaryInvite = {
	email: "sec@ktb.test",
	kind: "secretary",
	inviterName: "Dra. Ana",
} as const;

describe("invite tokens", () => {
	afterEach(() => vi.restoreAllMocks());

	it("mints 43 URL-safe characters with no padding, fresh on every call", () => {
		const first = newInviteToken();
		const second = newInviteToken();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).not.toBe(first);
	});

	it("swaps the base64 characters that are unsafe in a URL and drops the padding", () => {
		let pattern = [0xff];
		const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((bytes) => {
			const view = bytes as unknown as Uint8Array;
			view.forEach((_, i) => {
				view[i] = pattern[i % pattern.length]!;
			});
			return bytes;
		});
		// 32 bytes of 0xff are all "/" in base64, ending in "8=".
		expect(newInviteToken()).toBe(`${"_".repeat(42)}8`);
		// fb ef be repeats as "++++"; the trailing fb ef is "++8=".
		pattern = [0xfb, 0xef, 0xbe];
		expect(newInviteToken()).toBe(`${"-".repeat(42)}8`);
		expect(random.mock.calls[0]![0]).toHaveLength(32);
	});

	it("hashes a token to its hex SHA-256", async () => {
		expect(await hashInviteToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		const token = newInviteToken();
		const hash = await hashInviteToken(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashInviteToken(token)).toBe(hash);
		expect(await hashInviteToken(newInviteToken())).not.toBe(hash);
	});
});

describe("invites repo", () => {
	it("normalizes emails", () => {
		expect(normalizeEmail("  Sec@KTB.test ")).toBe("sec@ktb.test");
	});

	it("knows which addresses have an account", async () => {
		const db = freshDb();
		expect(await accountExists(db, "taken@ktb.test")).toBe(true);
		expect(await accountExists(db, "sec@ktb.test")).toBe(false);
	});

	it("stores only the token's hash, expiring a week from now", async () => {
		const db = freshDb();
		const token = await issueInvite(db, secretaryInvite, NOW);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const rows = await db.select().from(inviteTokens);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row).toMatchObject({ ...secretaryInvite, consumedAt: null });
		expect(row.tokenHash).toBe(await hashInviteToken(token));
		// The raw token is nowhere in what was persisted.
		expect(Object.values(row)).not.toContain(token);
		expect(JSON.stringify(row)).not.toContain(token);
		expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(row.expiresAt.getTime()).toBe(NOW.getTime() + INVITE_TTL_MS);
	});

	it("replaces the address's pending link of the same kind, and nothing else", async () => {
		const db = freshDb();
		// A link that already created its account stays on record.
		const used = await issueInvite(db, secretaryInvite, NOW);
		const usedRow = await findInvite(db, used, NOW);
		await consumeInvite(db, usedRow!.id, NOW);
		const first = await issueInvite(db, secretaryInvite, NOW);
		const otherKind = await issueInvite(db, { ...secretaryInvite, kind: "patient" }, NOW);
		const otherEmail = await issueInvite(db, { ...secretaryInvite, email: "other@ktb.test" }, NOW);
		expect(await findInvite(db, first, NOW)).not.toBeNull();

		const second = await issueInvite(db, { ...secretaryInvite, inviterName: "Dr. Caio" }, NOW);

		expect(second).not.toBe(first);
		expect(await findInvite(db, first, NOW)).toBeNull();
		expect(await findInvite(db, second, NOW)).toMatchObject({
			email: "sec@ktb.test",
			kind: "secretary",
			inviterName: "Dr. Caio",
		});
		expect(await findInvite(db, otherKind, NOW)).toMatchObject({
			email: "sec@ktb.test",
			kind: "patient",
		});
		expect(await findInvite(db, otherEmail, NOW)).toMatchObject({ email: "other@ktb.test" });
		const hashes = (await db.select().from(inviteTokens)).map((r) => r.tokenHash);
		expect(hashes).toHaveLength(4);
		expect(hashes).not.toContain(await hashInviteToken(first));
		const [consumed] = await db.select().from(inviteTokens).where(eq(inviteTokens.id, usedRow!.id));
		expect(consumed).toMatchObject({ tokenHash: await hashInviteToken(used), consumedAt: NOW });
	});

	it("finds a live link and nothing for unknown, used or expired ones", async () => {
		const db = freshDb();
		const token = await issueInvite(db, secretaryInvite, NOW);
		const expiresAt = NOW.getTime() + INVITE_TTL_MS;

		expect(await findInvite(db, newInviteToken(), NOW)).toBeNull();
		// The stored hash does not open the link either.
		expect(await findInvite(db, await hashInviteToken(token), NOW)).toBeNull();

		const live = await findInvite(db, token, NOW);
		expect(live).toMatchObject({ ...secretaryInvite, consumedAt: null });
		expect(await findInvite(db, token, new Date(expiresAt - 1))).toMatchObject({ id: live!.id });
		// Expired from the very instant it expires.
		expect(await findInvite(db, token, new Date(expiresAt))).toBeNull();
		expect(await findInvite(db, token, new Date(expiresAt + 1))).toBeNull();

		await consumeInvite(db, live!.id, NOW);
		expect(await findInvite(db, token, NOW)).toBeNull();
	});

	it("consumes only the link it is given", async () => {
		const db = freshDb();
		const used = await issueInvite(db, secretaryInvite, NOW);
		const kept = await issueInvite(db, { ...secretaryInvite, kind: "patient" }, NOW);
		const at = new Date(NOW.getTime() + 5_000);
		await consumeInvite(db, (await findInvite(db, used, NOW))!.id, at);
		const rows = await db.select().from(inviteTokens);
		expect(rows.map((r) => [r.kind, r.consumedAt])).toEqual([
			["secretary", at],
			["patient", null],
		]);
		expect(await findInvite(db, kept, NOW)).not.toBeNull();
	});
});

describe("InvitesLive", () => {
	const db = freshDb();
	const createVerified = vi.fn<(typeof Accounts)["Service"]["createVerified"]>();
	const claimInvites = vi.fn((_userId: string) => Effect.succeed(1));
	const syncLinks = vi.fn((_userId: string) => Effect.succeed(1));
	const created: CreateAccountResult = { ok: true, userId: "new-user" };

	const invitesLayer = InvitesLive.pipe(
		Layer.provide(
			Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(Accounts, { createVerified })),
		),
	);
	// Either directory may not be deployed: one runtime with both, one bare.
	let runtime: ManagedRuntime.ManagedRuntime<Invites | DoctorProfiles | PatientProfiles, never>;
	let bare: ManagedRuntime.ManagedRuntime<Invites, never>;

	beforeAll(() => {
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				invitesLayer,
				Layer.succeed(DoctorProfiles, { listFor: () => Effect.succeed([]), claimInvites }),
				Layer.succeed(PatientProfiles, { listFor: () => Effect.succeed([]), syncLinks }),
			),
		);
		bare = ManagedRuntime.make(invitesLayer);
	});

	afterAll(async () => {
		await runtime.dispose();
		await bare.dispose();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		createVerified.mockResolvedValue(created);
	});

	const invites = <A, E>(use: (svc: (typeof Invites)["Service"]) => Effect.Effect<A, E>) =>
		runtime.runPromise(Effect.flatMap(Invites, use));

	/** The rejection of an accept that must not go through. */
	const rejection = (
		input: { token: string; name: string; password: string },
		on: ManagedRuntime.ManagedRuntime<Invites, never> = runtime,
	) => on.runPromise(Effect.flatMap(Invites, (s) => Effect.flip(s.accept(input))));

	const issue = async (email: string, kind: "secretary" | "patient" = "secretary") => {
		const token = await invites((s) => s.issue({ email, kind, inviterName: "Dra. Ana" }));
		expect(token).not.toBeNull();
		return token!;
	};

	const rowFor = async (token: string) => {
		const [row] = await db
			.select()
			.from(inviteTokens)
			.where(eq(inviteTokens.tokenHash, await hashInviteToken(token)));
		return row!;
	};

	describe("issue", () => {
		it("issues a link for the normalized address", async () => {
			const before = Date.now();
			const token = await issue("  New.Person@KTB.Test ", "patient");
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			const row = await findInvite(db, token, new Date());
			expect(row).toMatchObject({
				email: "new.person@ktb.test",
				kind: "patient",
				inviterName: "Dra. Ana",
			});
			expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
			expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);
		});

		it("issues nothing for an address that already has an account", async () => {
			const before = await db.select().from(inviteTokens);
			const token = await invites((s) =>
				s.issue({ email: "  Taken@KTB.test ", kind: "secretary", inviterName: "Dra. Ana" }),
			);
			expect(token).toBeNull();
			expect(await db.select().from(inviteTokens)).toEqual(before);
		});
	});

	describe("preview", () => {
		it("is null for a link that opens nothing", async () => {
			expect(await invites((s) => s.preview(newInviteToken()))).toBeNull();
			expect(await invites((s) => s.preview(""))).toBeNull();
			const token = await issue("used@ktb.test");
			await consumeInvite(db, (await rowFor(token)).id, new Date());
			expect(await invites((s) => s.preview(token))).toBeNull();
		});

		it("shows who invited the address and to what", async () => {
			const token = await issue("Preview@ktb.test", "patient");
			expect(await invites((s) => s.preview(token))).toEqual({
				email: "preview@ktb.test",
				kind: "patient",
				inviterName: "Dra. Ana",
				accountExists: false,
			});
		});

		it("tells when the address got an account after the invite went out", async () => {
			const token = await issueInvite(
				db,
				{ email: "taken@ktb.test", kind: "secretary", inviterName: "Dr. Caio" },
				new Date(),
			);
			expect(await invites((s) => s.preview(token))).toEqual({
				email: "taken@ktb.test",
				kind: "secretary",
				inviterName: "Dr. Caio",
				accountExists: true,
			});
		});
	});

	describe("accept", () => {
		it("rejects a blank name before looking at the link or creating anything", async () => {
			const token = await issue("blank@ktb.test");
			const rejected = await rejection({ token, name: " \t ", password: "senha12345" });
			expect(rejected).toBeInstanceOf(InviteRejected);
			expect(rejected).toMatchObject({ _tag: "InviteRejected", code: "invalid_name" });
			// Also the answer for a dead link: the name is checked first.
			expect(
				(await rejection({ token: newInviteToken(), name: "", password: "senha12345" })).code,
			).toBe("invalid_name");
			expect(createVerified).not.toHaveBeenCalled();
			expect((await rowFor(token)).consumedAt).toBeNull();
		});

		it("rejects unknown, used and expired links without creating anything", async () => {
			const input = { name: "Maria Souza", password: "senha12345" };
			expect((await rejection({ ...input, token: newInviteToken() })).code).toBe("invalid");

			const used = await issue("dead@ktb.test");
			await consumeInvite(db, (await rowFor(used)).id, new Date());
			expect((await rejection({ ...input, token: used })).code).toBe("invalid");

			const expired = await issueInvite(
				db,
				{ email: "late@ktb.test", kind: "patient", inviterName: "Dra. Ana" },
				new Date(Date.now() - INVITE_TTL_MS - 1),
			);
			expect((await rejection({ ...input, token: expired })).code).toBe("invalid");

			expect(createVerified).not.toHaveBeenCalled();
			expect(claimInvites).not.toHaveBeenCalled();
			expect(syncLinks).not.toHaveBeenCalled();
		});

		it.each([
			["exists", "account_exists"],
			["invalid_password", "invalid_password"],
		] as const)(
			"maps the accounts port's %s to %s and keeps the link usable",
			async (error, code) => {
				const token = await issue(`${error}@ktb.test`);
				createVerified.mockResolvedValueOnce({ ok: false, error });
				const rejected = await rejection({ token, name: "Maria Souza", password: "short" });
				expect(rejected).toBeInstanceOf(InviteRejected);
				expect(rejected.code).toBe(code);
				expect(createVerified).toHaveBeenCalledTimes(1);
				expect(claimInvites).not.toHaveBeenCalled();
				expect(syncLinks).not.toHaveBeenCalled();
				// Not consumed: the same link works once the cause is gone.
				expect((await rowFor(token)).consumedAt).toBeNull();
				expect(
					await invites((s) => s.accept({ token, name: "Maria Souza", password: "senha12345" })),
				).toEqual({ email: `${error}@ktb.test`, kind: "secretary" });
			},
		);

		it("creates a verified account for the invited address and consumes the link", async () => {
			const token = await issue("  Maria@KTB.test ", "patient");
			// Whatever else the caller sends, the account is for the invited address.
			const input = {
				token,
				name: "  Maria Souza ",
				password: " senha 12345 ",
				email: "attacker@evil.test",
			};
			const before = Date.now();
			expect(await invites((s) => s.accept(input))).toEqual({
				email: "maria@ktb.test",
				kind: "patient",
			});
			expect(createVerified).toHaveBeenCalledTimes(1);
			expect(createVerified).toHaveBeenCalledWith({
				email: "maria@ktb.test",
				name: "Maria Souza",
				password: " senha 12345 ",
			});
			expect(claimInvites.mock.calls).toEqual([["new-user"]]);
			expect(syncLinks.mock.calls).toEqual([["new-user"]]);

			const consumedAt = (await rowFor(token)).consumedAt;
			expect(consumedAt!.getTime()).toBeGreaterThanOrEqual(before);
			expect(consumedAt!.getTime()).toBeLessThanOrEqual(Date.now());

			// Single use: the same link opens and creates nothing afterwards.
			expect(await invites((s) => s.preview(token))).toBeNull();
			expect((await rejection({ token, name: "Maria Souza", password: "senha12345" })).code).toBe(
				"invalid",
			);
			expect(createVerified).toHaveBeenCalledTimes(1);
			expect(claimInvites).toHaveBeenCalledTimes(1);
			expect(syncLinks).toHaveBeenCalledTimes(1);
		});

		it("works when neither profile directory is deployed", async () => {
			const token = await issue("solo@ktb.test");
			const accepted = await bare.runPromise(
				Effect.flatMap(Invites, (s) => s.accept({ token, name: "Solo", password: "senha12345" })),
			);
			expect(accepted).toEqual({ email: "solo@ktb.test", kind: "secretary" });
			expect(createVerified).toHaveBeenCalledWith({
				email: "solo@ktb.test",
				name: "Solo",
				password: "senha12345",
			});
			expect(claimInvites).not.toHaveBeenCalled();
			expect(syncLinks).not.toHaveBeenCalled();
			expect((await rejection({ token, name: "Solo", password: "senha12345" }, bare)).code).toBe(
				"invalid",
			);
		});
	});

	describe("inviteAcceptPath", () => {
		const input = { email: "  Path@KTB.test ", kind: "patient", inviterName: "Dra. Ana" } as const;

		it("is null when invite links are not deployed", async () => {
			const before = await db.select().from(inviteTokens);
			expect(await Effect.runPromise(inviteAcceptPath(input))).toBeNull();
			expect(await db.select().from(inviteTokens)).toEqual(before);
		});

		it("is null when the address already has an account", async () => {
			expect(
				await runtime.runPromise(inviteAcceptPath({ ...input, email: "taken@ktb.test" })),
			).toBeNull();
		});

		it("is the accept page of a freshly issued link", async () => {
			const path = await runtime.runPromise(inviteAcceptPath(input));
			// The token rides in the fragment, never in the path or the query.
			expect(path).toMatch(/^\/invite#[A-Za-z0-9_-]{43}$/);
			const token = path!.slice("/invite#".length);
			expect(await findInvite(db, token, new Date())).toMatchObject({
				email: "path@ktb.test",
				kind: "patient",
				inviterName: "Dra. Ana",
			});
		});
	});
});

describe("invite destinations", () => {
	it("sends each kind to its own home and sign-in screen", () => {
		expect(INVITE_KINDS).toEqual(["secretary", "patient"]);
		expect(Object.keys(INVITE_DESTINATIONS)).toEqual([...INVITE_KINDS]);
		expect(INVITE_DESTINATIONS.secretary).toEqual({ home: "/", login: "/login/secretary" });
		expect(INVITE_DESTINATIONS.patient).toEqual({
			home: "/portal/patient",
			login: "/login/patient",
		});
	});
});

describe("invites plugins", () => {
	it("contributes the invite_tokens table, the service and the accept route", () => {
		expect(plugins).toEqual([invitesTablesPlugin, invitesServicesPlugin, invitesRoutesPlugin]);
		expect(plugins.map((p) => p.id)).toEqual([
			"invites.tables",
			"invites.services",
			"invites.routes",
		]);
		expect(invitesTablesPlugin.tables).toEqual({ inviteTokens });
		expect(invitesTablesPlugin.tables.inviteTokens).toBe(inviteTokens);
		expect(invitesServicesPlugin.services).toBe(InvitesLive);
		expect(invitesRoutesPlugin.routes).toEqual([
			{
				type: "physical",
				pathPrefix: "/invite",
				directory: "../../../../plugins/invites/src/routes",
			},
		]);
	});
});
