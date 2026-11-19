import { describe, expect, it } from "vitest";

import {
	actingAs,
	DOCTOR_PROFILE_COOKIE,
	DoctorDelegations,
	DoctorProfiles,
	PATIENT_PROFILE_COOKIE,
	PatientProfiles,
	profileIdFromHeaders,
	resolveDoctorProfile,
	resolvePatientProfile,
	type DoctorProfile,
	type PatientProfile,
} from "./profiles.ts";

const cookie = (value: string) => new Headers({ cookie: value });

describe("profile ports", () => {
	it("declare stable service keys", () => {
		expect(DoctorProfiles.key).toBe("@ktb/auth/DoctorProfiles");
		expect(DoctorDelegations.key).toBe("@ktb/auth/DoctorDelegations");
		expect(PatientProfiles.key).toBe("@ktb/auth/PatientProfiles");
	});

	it("declare stable cookie names", () => {
		expect(DOCTOR_PROFILE_COOKIE).toBe("ktb_doctor");
		expect(PATIENT_PROFILE_COOKIE).toBe("ktb_patient");
	});
});

describe("profileIdFromHeaders", () => {
	it("reads the selected id among other cookies", () => {
		const headers = cookie(
			`ktb-locale=pt-BR; ${DOCTOR_PROFILE_COOKIE}=12; ${PATIENT_PROFILE_COOKIE}=7`,
		);
		expect(profileIdFromHeaders(headers, DOCTOR_PROFILE_COOKIE)).toBe(12);
		expect(profileIdFromHeaders(headers, PATIENT_PROFILE_COOKIE)).toBe(7);
	});

	it("is null without the cookie", () => {
		expect(profileIdFromHeaders(new Headers(), DOCTOR_PROFILE_COOKIE)).toBeNull();
		expect(profileIdFromHeaders(cookie("flag; other=1"), DOCTOR_PROFILE_COOKIE)).toBeNull();
		// A name that merely ends with the cookie name is a different cookie.
		expect(profileIdFromHeaders(cookie("x_ktb_doctor=3"), DOCTOR_PROFILE_COOKIE)).toBeNull();
	});

	it("finds the cookie past pairs without a value or a match", () => {
		expect(profileIdFromHeaders(cookie("ktb_doctor; ktb_doctor=5"), DOCTOR_PROFILE_COOKIE)).toBe(5);
		expect(profileIdFromHeaders(cookie("junk; ktb_doctor=5"), DOCTOR_PROFILE_COOKIE)).toBe(5);
		expect(profileIdFromHeaders(cookie("a=1; ktb_doctor=5"), DOCTOR_PROFILE_COOKIE)).toBe(5);
		// A valueless cookie whose name is the target plus one char must
		// still be skipped: slice(0, -1) would otherwise match the name.
		expect(profileIdFromHeaders(cookie("ktb_doctorx; ktb_doctor=5"), DOCTOR_PROFILE_COOKIE)).toBe(
			5,
		);
	});

	it("trims whitespace around the selected id", () => {
		expect(profileIdFromHeaders(cookie("ktb_doctor= 12 "), DOCTOR_PROFILE_COOKIE)).toBe(12);
		expect(profileIdFromHeaders(cookie("other=1; ktb_doctor=\t7"), DOCTOR_PROFILE_COOKIE)).toBe(7);
	});

	it("rejects values that are not positive integers", () => {
		for (const value of ["", "0", "-1", "1.5", "abc", "1 OR 1=1"]) {
			expect(profileIdFromHeaders(cookie(`ktb_doctor=${value}`), DOCTOR_PROFILE_COOKIE)).toBeNull();
		}
	});
});

describe("actingAs", () => {
	const user = { id: "sec", email: "sec@ktb.test", name: "Sec" };
	const doctor: DoctorProfile = {
		doctorId: 1,
		userId: "doc",
		email: "doc@ktb.test",
		displayName: "Dra",
		role: "secretary",
	};

	it("acts as the signed-in user when no profile applies", () => {
		expect(actingAs(user, null)).toEqual({
			...user,
			actorId: "sec",
			doctor: { name: "Sec", email: "sec@ktb.test" },
		});
	});

	it("scopes to the doctor while keeping the actor's identity", () => {
		expect(actingAs(user, doctor)).toEqual({
			id: "doc",
			email: "sec@ktb.test",
			name: "Sec",
			actorId: "sec",
			doctor: { name: "Dra", email: "doc@ktb.test" },
		});
	});
});

describe("resolvePatientProfile", () => {
	const me: PatientProfile = { patientId: 1, name: "Ana", relation: "self" };
	const kid: PatientProfile = { patientId: 2, name: "Leo", relation: "guardian" };

	it("opens the selected profile when the user holds it", () => {
		expect(resolvePatientProfile([me, kid], 2)).toBe(kid);
	});

	it("falls back to the only profile", () => {
		expect(resolvePatientProfile([me], null)).toBe(me);
		expect(resolvePatientProfile([me], 99)).toBe(me);
	});

	it("is null when a choice is needed or nothing is linked", () => {
		expect(resolvePatientProfile([me, kid], null)).toBeNull();
		expect(resolvePatientProfile([me, kid], 99)).toBeNull();
		expect(resolvePatientProfile([], 1)).toBeNull();
	});
});

describe("resolveDoctorProfile", () => {
	const profile = (doctorId: number, role: DoctorProfile["role"]): DoctorProfile => ({
		doctorId,
		userId: `doc-${doctorId}`,
		email: `doc-${doctorId}@ktb.test`,
		displayName: `Doctor ${doctorId}`,
		role,
	});
	const own = profile(1, "owner");
	const a = profile(2, "secretary");
	const b = profile(3, "secretary");

	it("acts as the selected profile when the user holds it", () => {
		expect(resolveDoctorProfile([own, a], 2)).toBe(a);
	});

	it("defaults to the user's own profile", () => {
		expect(resolveDoctorProfile([own, a, b], null)).toBe(own);
		expect(resolveDoctorProfile([own, a], 99)).toBe(own);
	});

	it("prefers the owner's profile even when it is not first", () => {
		expect(resolveDoctorProfile([a, own], null)).toBe(own);
		expect(resolveDoctorProfile([a, b, own], 99)).toBe(own);
	});

	it("defaults to the first delegated profile", () => {
		expect(resolveDoctorProfile([a], null)).toBe(a);
		expect(resolveDoctorProfile([a, b], null)).toBe(a);
		expect(resolveDoctorProfile([a, b], 99)).toBe(a);
	});

	it("is null only when the user holds no profile", () => {
		expect(resolveDoctorProfile([], 1)).toBeNull();
	});
});
