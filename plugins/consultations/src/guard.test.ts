import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	doctorAccessFn: vi.fn<() => Promise<"anonymous" | "no-doctor" | "doctor">>(),
	clinicalPortalFn: vi.fn<() => Promise<"doctor" | "secretary" | null>>(),
}));

vi.mock("./fns.ts", () => ({
	doctorAccessFn: mocks.doctorAccessFn,
	clinicalPortalFn: mocks.clinicalPortalFn,
}));

import { isRedirect } from "@tanstack/react-router";

import { redirectToPortal } from "./guard.ts";

// redirect() returns a Response carrying the navigation options.
const redirectTarget = async () => {
	const caught = await redirectToPortal("/consultations").catch((e: unknown) => e);
	expect(isRedirect(caught)).toBe(true);
	return (caught as Response & { options: { to?: string; href?: string } }).options;
};

describe("redirectToPortal", () => {
	it("redirects anonymous visitors to the doctor sign-in", async () => {
		mocks.doctorAccessFn.mockResolvedValue("anonymous");
		expect((await redirectTarget()).href).toBe("/login/doctor");
	});

	it("redirects accounts without a doctor profile to the chooser", async () => {
		mocks.doctorAccessFn.mockResolvedValue("no-doctor");
		expect((await redirectTarget()).to).toBe("/doctors/select");
	});

	it("sends owners into the doctor portal", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue("doctor");
		expect((await redirectTarget()).href).toBe("/portal/doctor/consultations");
	});

	it("sends delegated-only accounts into the secretary portal", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue("secretary");
		expect((await redirectTarget()).href).toBe("/portal/secretary/consultations");
	});

	it("falls back to the doctor portal when the instance cannot resolve", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue(null);
		expect((await redirectTarget()).href).toBe("/portal/doctor/consultations");
	});
});
