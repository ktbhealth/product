import { describe, expect, it } from "vitest";

import { PORTAL_AUDIENCE, instanceAudience, portalAdmits } from "./rules.ts";

describe("portal audience rules", () => {
	it("defaults an absent audience to member", () => {
		expect(instanceAudience({ id: "x", basePath: "/portal/x", label: "X" })).toBe(
			PORTAL_AUDIENCE.member,
		);
		expect(
			instanceAudience({
				id: "x",
				basePath: "/p",
				label: "X",
				audience: "doctor",
			}),
		).toBe("doctor");
	});

	it("admits instances whose rule is satisfied", () => {
		const open = { id: "open", basePath: "/portal/open", label: "Open" };
		const medics = {
			id: "medics",
			basePath: "/portal/medics",
			label: "M",
			audience: "doctor",
		};
		expect(portalAdmits(open, [PORTAL_AUDIENCE.member])).toBe(true);
		expect(portalAdmits(open, [])).toBe(false);
		expect(portalAdmits(medics, new Set([PORTAL_AUDIENCE.doctor]))).toBe(true);
		expect(portalAdmits(medics, [PORTAL_AUDIENCE.member])).toBe(false);
	});

	it("admits every instance to the superadmin wildcard", () => {
		const medics = {
			id: "medics",
			basePath: "/portal/medics",
			label: "M",
			audience: "doctor",
		};
		const patients = {
			id: "patients",
			basePath: "/portal/patients",
			label: "P",
			audience: "patient",
		};
		const admins = new Set([PORTAL_AUDIENCE.member, PORTAL_AUDIENCE.superadmin]);
		expect(portalAdmits(medics, admins)).toBe(true);
		expect(portalAdmits(patients, admins)).toBe(true);
		// Without the wildcard the same set admits nothing extra.
		expect(portalAdmits(medics, [PORTAL_AUDIENCE.member])).toBe(false);
	});
});
