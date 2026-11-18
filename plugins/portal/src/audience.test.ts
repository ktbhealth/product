import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DoctorProfiles, PatientProfiles, type DoctorProfile } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { PlatformAdmin } from "@ktb/platform";

import { PortalAudience, PortalAudienceLive } from "./index.ts";
import { PORTAL_AUDIENCE } from "./rules.ts";

const profile = (role: DoctorProfile["role"], userId = "u1"): DoctorProfile => ({
	doctorId: 1,
	userId,
	email: `${userId}@ktb.test`,
	displayName: "Dr. X",
	role,
});

// The gate now receives a { email, userId } subject — the mock admits
// the allowlisted email OR the RBAC-granted account id.
const adminGate = Layer.succeed(PlatformAdmin, {
	isAdmin: (subject) =>
		Effect.succeed(
			(typeof subject === "string" ? subject : subject?.email) === "admin@ktb.test" ||
				(typeof subject === "object" && subject?.userId === "rbac-root"),
		),
	requireAdmin: () => Effect.void,
});

const directory = (profiles: readonly DoctorProfile[] | ((id: string) => DoctorProfile[])) =>
	Layer.succeed(DoctorProfiles, {
		listFor: (userId) =>
			Effect.succeed(typeof profiles === "function" ? profiles(userId) : profiles),
		claimInvites: () => Effect.succeed(0),
	});

const patientDirectory = (profiles: readonly { patientId: number }[]) =>
	Layer.succeed(PatientProfiles, {
		listFor: () => Effect.succeed(profiles as never),
		syncLinks: () => Effect.succeed(0),
	});

const audiencesAs = (
	principal: { userId: string; email?: string; actorId?: string } | null,
	services?: {
		readonly admin?: Layer.Layer<PlatformAdmin>;
		readonly profiles?: Layer.Layer<DoctorProfiles>;
		readonly patients?: Layer.Layer<PatientProfiles>;
	},
) =>
	Effect.runPromise(
		Effect.flatMap(PortalAudience, (svc) => svc.audiences()).pipe(
			Effect.provide(PortalAudienceLive),
			Effect.provideService(Principal, principal),
			Effect.provide(services?.admin ?? Layer.empty),
			Effect.provide(services?.profiles ?? Layer.empty),
			Effect.provide(services?.patients ?? Layer.empty),
		),
	);

describe("PortalAudience.audiences", () => {
	it("is empty without a principal", async () => {
		expect(await audiencesAs(null)).toEqual(new Set());
	});

	it("grants only member with no optional services deployed", async () => {
		expect(await audiencesAs({ userId: "u1", email: "u1@ktb.test" })).toEqual(
			new Set([PORTAL_AUDIENCE.member]),
		);
	});

	it("grants platform-admin + superadmin to allowlisted emails", async () => {
		expect(
			await audiencesAs({ userId: "u1", email: "admin@ktb.test" }, { admin: adminGate }),
		).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.platformAdmin, PORTAL_AUDIENCE.superadmin]),
		);
		expect(await audiencesAs({ userId: "u1", email: "u1@ktb.test" }, { admin: adminGate })).toEqual(
			new Set([PORTAL_AUDIENCE.member]),
		);
	});

	it("grants superadmin through the RBAC grant path — signed-in account id", async () => {
		// The gate sees actorId under delegation: the grant belongs to the
		// signed-in account, not the doctor being acted as.
		const set = await audiencesAs(
			{ userId: "doctor-1", actorId: "rbac-root", email: "root@ktb.test" },
			{ admin: adminGate },
		);
		expect(set).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.platformAdmin, PORTAL_AUDIENCE.superadmin]),
		);
		// A delegated principal acting AS the granted account does not
		// inherit it — actorId is someone else.
		const delegated = await audiencesAs(
			{ userId: "rbac-root", actorId: "someone-else", email: "other@ktb.test" },
			{ admin: adminGate },
		);
		expect(delegated).toEqual(new Set([PORTAL_AUDIENCE.member]));
	});

	it("grants doctor for an own profile and secretary for delegated ones", async () => {
		// `clinician` rides along on either clinical role.
		expect(
			await audiencesAs({ userId: "u1" }, { profiles: directory([profile("owner")]) }),
		).toEqual(new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.doctor, PORTAL_AUDIENCE.clinician]));
		expect(
			await audiencesAs({ userId: "u1" }, { profiles: directory([profile("secretary")]) }),
		).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.secretary, PORTAL_AUDIENCE.clinician]),
		);
		expect(
			await audiencesAs(
				{ userId: "u1" },
				{ profiles: directory([profile("owner"), profile("secretary")]) },
			),
		).toEqual(
			new Set([
				PORTAL_AUDIENCE.member,
				PORTAL_AUDIENCE.doctor,
				PORTAL_AUDIENCE.secretary,
				PORTAL_AUDIENCE.clinician,
			]),
		);
	});

	it("resolves profiles for the signed-in account under delegation", async () => {
		const seen: string[] = [];
		const set = await audiencesAs(
			{ userId: "doc1", actorId: "sec1", email: "sec1@ktb.test" },
			{
				profiles: directory((id) => {
					seen.push(id);
					return id === "sec1" ? [profile("secretary", "doc1")] : [];
				}),
			},
		);
		expect(seen).toEqual(["sec1"]);
		expect(set).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.secretary, PORTAL_AUDIENCE.clinician]),
		);
	});

	it("degrades to member when the directory fails", async () => {
		const broken = Layer.succeed(DoctorProfiles, {
			listFor: () => Effect.fail("boom" as never),
			claimInvites: () => Effect.succeed(0),
		});
		expect(await audiencesAs({ userId: "u1" }, { profiles: broken })).toEqual(
			new Set([PORTAL_AUDIENCE.member]),
		);
	});

	it("grants patient to an account with no doctor side at all", async () => {
		// patientOnly — covers invited users still waiting on email
		// verification (their links are not active yet).
		expect(await audiencesAs({ userId: "u1" }, { profiles: directory([]) })).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.patient]),
		);
	});

	it("grants patient to any holder of an active link — clinical roles included", async () => {
		const patients = patientDirectory([{ patientId: 1 }]);
		expect(
			await audiencesAs({ userId: "doc1" }, { profiles: directory([profile("owner")]), patients }),
		).toEqual(
			new Set([
				PORTAL_AUDIENCE.member,
				PORTAL_AUDIENCE.doctor,
				PORTAL_AUDIENCE.clinician,
				PORTAL_AUDIENCE.patient,
			]),
		);
	});

	it("denies patient to clinical accounts holding no links", async () => {
		expect(
			await audiencesAs(
				{ userId: "doc1" },
				{ profiles: directory([profile("owner")]), patients: patientDirectory([]) },
			),
		).toEqual(new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.doctor, PORTAL_AUDIENCE.clinician]));
	});

	it("treats a failing patient-link lookup as no links", async () => {
		const patients = Layer.succeed(PatientProfiles, {
			listFor: () => Effect.fail("boom" as never),
			syncLinks: () => Effect.succeed(0),
		});
		const set = await audiencesAs(
			{ userId: "doc1" },
			{ profiles: directory([profile("owner")]), patients },
		);
		expect(set).toEqual(
			new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.doctor, PORTAL_AUDIENCE.clinician]),
		);
	});

	it("resolves patient links for the signed-in account under delegation", async () => {
		// A secretary acting for a doctor sees the portal through her OWN
		// links — audiences describe who is signed in, not who they act as.
		const seen: string[] = [];
		const patients = Layer.succeed(PatientProfiles, {
			listFor: (id: string) => {
				seen.push(id);
				return Effect.succeed(id === "sec1" ? ([{ patientId: 7 }] as never) : []);
			},
			syncLinks: () => Effect.succeed(0),
		});
		const set = await audiencesAs(
			{ userId: "doc1", actorId: "sec1" },
			{ profiles: directory([profile("secretary", "doc1")]), patients },
		);
		expect(seen).toEqual(["sec1"]);
		expect(set).toEqual(
			new Set([
				PORTAL_AUDIENCE.member,
				PORTAL_AUDIENCE.secretary,
				PORTAL_AUDIENCE.clinician,
				PORTAL_AUDIENCE.patient,
			]),
		);
	});
});
