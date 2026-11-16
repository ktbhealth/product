import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DoctorProfiles, type DoctorProfile } from "@ktb/auth";
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

const adminGate = Layer.succeed(PlatformAdmin, {
	isAdmin: (email) => Effect.succeed(email === "admin@ktb.test"),
	requireAdmin: () => Effect.void,
});

const directory = (profiles: readonly DoctorProfile[] | ((id: string) => DoctorProfile[])) =>
	Layer.succeed(DoctorProfiles, {
		listFor: (userId) =>
			Effect.succeed(typeof profiles === "function" ? profiles(userId) : profiles),
		claimInvites: () => Effect.succeed(0),
	});

const audiencesAs = (
	principal: { userId: string; email?: string; actorId?: string } | null,
	services?: {
		readonly admin?: Layer.Layer<PlatformAdmin>;
		readonly profiles?: Layer.Layer<DoctorProfiles>;
	},
) =>
	Effect.runPromise(
		Effect.flatMap(PortalAudience, (svc) => svc.audiences()).pipe(
			Effect.provide(PortalAudienceLive),
			Effect.provideService(Principal, principal),
			Effect.provide(services?.admin ?? Layer.empty),
			Effect.provide(services?.profiles ?? Layer.empty),
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

	it("grants platform-admin to allowlisted emails", async () => {
		expect(
			await audiencesAs({ userId: "u1", email: "admin@ktb.test" }, { admin: adminGate }),
		).toEqual(new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.platformAdmin]));
		expect(await audiencesAs({ userId: "u1", email: "u1@ktb.test" }, { admin: adminGate })).toEqual(
			new Set([PORTAL_AUDIENCE.member]),
		);
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
});
