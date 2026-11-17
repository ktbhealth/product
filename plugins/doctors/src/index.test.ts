import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DoctorDelegations, DoctorProfiles, type DoctorProfile } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	DoctorProfilesLive,
	Doctors,
	DoctorsLive,
	doctorsChromePlugin,
	doctorsPagesPlugin,
	doctorsRoutesPlugin,
	doctorsServicesPlugin,
	doctorsTablesPlugin,
	ensureDoctorProfile,
	getDoctorByUser,
	listOwnDoctorProfiles,
	plugins,
} from "./index.ts";
import { doctors } from "./schema.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
INSERT INTO "user" VALUES ('u1', 'ana@ktb.test'), ('sec', 'sec@ktb.test');
CREATE TABLE doctors (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, crm TEXT, specialty TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
`;

describe("doctors repo", () => {
	const db = makeDb(makeD1(DDL));

	it("has no profile for an unknown user", async () => {
		expect(await getDoctorByUser(db, "u1")).toBeNull();
	});

	it("creates the profile once and keeps it on later calls", async () => {
		const created = await ensureDoctorProfile(db, "u1", "Dra. Ana");
		expect(created).toMatchObject({ userId: "u1", displayName: "Dra. Ana" });
		const again = await ensureDoctorProfile(db, "u1", "Another Name");
		expect(again.id).toBe(created.id);
		expect(again.displayName).toBe("Dra. Ana");
		expect(await db.select().from(doctors)).toHaveLength(1);
	});
});

describe("doctor profile directory", () => {
	const db = makeDb(makeD1(DDL));
	const own: DoctorProfile = {
		doctorId: 1,
		userId: "u1",
		email: "ana@ktb.test",
		displayName: "Dra. Ana",
		role: "owner",
	};
	const delegated: DoctorProfile = {
		doctorId: 7,
		userId: "u7",
		email: "caio@ktb.test",
		displayName: "Dr. Caio",
		role: "secretary",
	};
	const claimed: string[] = [];
	const delegations = Layer.succeed(DoctorDelegations, {
		listFor: (userId) => Effect.succeed(userId === "stranger" ? [] : [delegated]),
		claimInvites: (userId) => Effect.sync(() => claimed.push(userId)),
	});

	const directory = <A>(
		use: (d: (typeof DoctorProfiles)["Service"]) => Effect.Effect<A>,
		source: Layer.Layer<DoctorDelegations> | null = null,
	) =>
		Effect.runPromise(
			Effect.flatMap(DoctorProfiles, use).pipe(
				Effect.provide(DoctorProfilesLive.pipe(Layer.provide(Layer.succeed(Db, db)))),
				source === null ? (effect) => effect : Effect.provide(source),
			),
		);

	beforeAll(async () => {
		await ensureDoctorProfile(db, "u1", "Dra. Ana");
	});

	it("lists a doctor's own profile as owner, and nothing for other accounts", async () => {
		expect(await listOwnDoctorProfiles(db, "u1")).toEqual([own]);
		expect(await listOwnDoctorProfiles(db, "sec")).toEqual([]);
	});

	it("is the own profile alone when no delegation source is deployed", async () => {
		expect(await directory((d) => d.listFor("u1"))).toEqual([own]);
		expect(await directory((d) => d.listFor("sec"))).toEqual([]);
		expect(await directory((d) => d.claimInvites("sec"))).toBe(0);
	});

	it("adds the delegated profiles after the own one", async () => {
		expect(await directory((d) => d.listFor("u1"), delegations)).toEqual([own, delegated]);
		expect(await directory((d) => d.listFor("sec"), delegations)).toEqual([delegated]);
		expect(await directory((d) => d.listFor("stranger"), delegations)).toEqual([]);
	});

	it("claims invites through the delegation source", async () => {
		expect(await directory((d) => d.claimInvites("sec"), delegations)).toBe(1);
		expect(claimed).toEqual(["sec"]);
	});
});

describe("switch-doctor portal loader", () => {
	const db = makeDb(makeD1(DDL));
	const own: DoctorProfile = {
		doctorId: 1,
		userId: "u1",
		email: "ana@ktb.test",
		displayName: "Dra. Ana",
		role: "owner",
	};
	const delegated: DoctorProfile = {
		doctorId: 7,
		userId: "u7",
		email: "caio@ktb.test",
		displayName: "Dr. Caio",
		role: "secretary",
	};
	const delegations = Layer.succeed(DoctorDelegations, {
		listFor: (userId) => Effect.succeed(userId === "u1" || userId === "sec" ? [delegated] : []),
		claimInvites: () => Effect.succeed(0),
	});
	const loader = doctorsPagesPlugin.pages?.[0]?.loader;

	beforeAll(async () => {
		await ensureDoctorProfile(db, "u1", "Dra. Ana");
	});

	const runLoader = (principal: { userId: string; actorId?: string } | null) =>
		Effect.runPromise(
			(loader ?? ((_path: string) => Effect.fail(new Error("missing loader"))))(
				"/portal/doctor/switch-doctor",
			).pipe(
				Effect.provideService(Principal, principal),
				Effect.provide(DoctorProfilesLive.pipe(Layer.provide(Layer.succeed(Db, db)))),
				Effect.provide(delegations),
			) as Effect.Effect<unknown>,
		);

	it("lists the account's profiles with the acting one active", async () => {
		expect(await runLoader({ userId: "u1" })).toEqual({
			profiles: [own, delegated].map(({ doctorId, displayName, role }) => ({
				doctorId,
				displayName,
				role,
			})),
			activeDoctorId: own.doctorId,
		});
	});

	it("marks the delegated profile active while acting as it", async () => {
		expect(await runLoader({ userId: "u7", actorId: "sec" })).toEqual({
			profiles: [
				{
					doctorId: delegated.doctorId,
					displayName: delegated.displayName,
					role: delegated.role,
				},
			],
			activeDoctorId: delegated.doctorId,
		});
	});

	it("is empty without a principal or a deployed directory", async () => {
		expect(await runLoader(null)).toEqual({ profiles: [], activeDoctorId: null });
		await expect(
			Effect.runPromise(
				(loader ?? ((_path: string) => Effect.fail(new Error("missing loader"))))("/portal/x").pipe(
					Effect.provideService(Principal, { userId: "u1" }),
				) as Effect.Effect<unknown>,
			),
		).resolves.toEqual({ profiles: [], activeDoctorId: null });
	});
});

describe("DoctorsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Doctors, never>;
	const db = makeDb(makeD1(DDL));

	beforeAll(() => {
		runtime = ManagedRuntime.make(DoctorsLive.pipe(Layer.provide(Layer.succeed(Db, db))));
	});

	afterAll(() => runtime.dispose());

	const ensureAs = (principal: { userId: string; actorId?: string } | null) =>
		runtime.runPromise(
			Effect.flatMap(Doctors, (svc) => svc.ensureProfile("Dra. Ana")).pipe(
				Effect.provideService(Principal, principal),
				Effect.catchTag("Forbidden", (e) => Effect.succeed(`forbidden:${e.path}`)),
			),
		);

	it("creates the caller's own profile", async () => {
		expect(await ensureAs({ userId: "u1" })).toMatchObject({
			userId: "u1",
			displayName: "Dra. Ana",
		});
	});

	it("refuses without a principal and under delegation", async () => {
		expect(await ensureAs(null)).toBe("forbidden:doctor.create");
		expect(await ensureAs({ userId: "u2", actorId: "sec" })).toBe("forbidden:doctor.create");
		expect(await getDoctorByUser(db, "u2")).toBeNull();
	});

	const nameAs = (principal: { userId: string } | null, userId: string) =>
		runtime.runPromise(
			Effect.flatMap(Doctors, (svc) => svc.displayName(userId)).pipe(
				Effect.provideService(Principal, principal),
				Effect.catchTag("Forbidden", (e) => Effect.succeed(`forbidden:${e.path}`)),
			),
		);

	it("displayName resolves a doctor profile for any principal", async () => {
		// u1's profile was ensured by the test above.
		expect(await nameAs({ userId: "u1" }, "u1")).toBe("Dra. Ana");
		expect(await nameAs({ userId: "sec" }, "u1")).toBe("Dra. Ana");
		expect(await nameAs({ userId: "u1" }, "ghost")).toBeNull();
	});

	it("displayName fails Forbidden without a principal", async () => {
		expect(await nameAs(null, "u1")).toBe("forbidden:doctor.read");
	});
});

describe("doctors plugins", () => {
	it("contributes the doctors table and service", () => {
		expect(plugins).toEqual([
			doctorsTablesPlugin,
			doctorsServicesPlugin,
			doctorsRoutesPlugin,
			doctorsPagesPlugin,
			doctorsChromePlugin,
		]);
		expect(doctorsRoutesPlugin.id).toBe("doctors.routes");
		expect(doctorsRoutesPlugin.routes).toHaveLength(1);
		expect(doctorsTablesPlugin.id).toBe("doctors.tables");
		expect(doctorsTablesPlugin.tables.doctors).toBe(doctors);
		expect(doctorsServicesPlugin.id).toBe("doctors.services");
		expect(doctorsServicesPlugin.services).toBeDefined();
	});

	it("mounts the profile chooser inside both clinical portals", () => {
		expect(doctorsPagesPlugin.requiredDeps).toEqual(["portal.shell"]);
		expect(doctorsPagesPlugin.pages).toHaveLength(2);
		expect((doctorsPagesPlugin.pages ?? []).map((p) => p.path)).toEqual([
			"/portal/doctor/switch-doctor",
			"/portal/secretary/switch-doctor",
		]);
		for (const page of doctorsPagesPlugin.pages ?? []) {
			expect(page.component).toBeDefined();
			expect(page.loader).toBeDefined();
		}
	});

	it("links both clinical sidebars to the in-portal chooser", () => {
		expect(doctorsChromePlugin.requiredDeps).toEqual(["portal.shell"]);
		const entries = doctorsChromePlugin.chrome ?? [];
		expect(entries.map((e) => e.portal)).toEqual(["doctor", "secretary"]);
		for (const entry of entries) {
			expect(entry.region).toBe("portal.sidebar");
			// Hidden for single-profile accounts — nothing to switch to.
			expect(entry.when).toEqual({ minDoctorProfiles: 2 });
			expect(entry.content).toMatchObject({
				kind: "sidebarItem",
				item: {
					to: `/portal/${entry.portal}/switch-doctor`,
					label: "Switch doctor",
					group: "Account",
				},
			});
		}
	});
});
