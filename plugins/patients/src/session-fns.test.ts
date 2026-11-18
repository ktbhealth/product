import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	getDoctorAccess: vi.fn(),
	getDoctorContext: vi.fn(),
	getLocale: vi.fn(),
	sessionUserFn: vi.fn(),
}));

// Same fake as the host's route tests: the handler runs as a plain async fn.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", () => ({
	ensureDoctorUser: vi.fn(),
	getDoctorAccess: mocks.getDoctorAccess,
	getDoctorContext: mocks.getDoctorContext,
	getDoctorUser: vi.fn(),
	getLocale: mocks.getLocale,
	getServerRuntime: vi.fn(),
	getSessionUser: mocks.getSessionUser,
	purgeAudio: vi.fn(),
	runAs: vi.fn(),
}));

import { clinicalPortalFn, doctorAccessFn, localeFn, sessionUserFn } from "./fns.ts";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("session and locale server fns", () => {
	it("sessionUserFn returns the signed-in user", async () => {
		const user = { id: "u1", email: "a@x.com", name: "A" };
		mocks.getSessionUser.mockResolvedValue(user);
		await expect(sessionUserFn()).resolves.toBe(user);
	});

	it("sessionUserFn returns null for anonymous visitors", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(sessionUserFn()).resolves.toBeNull();
	});

	it("doctorAccessFn returns the request's doctor-side standing", async () => {
		mocks.getDoctorAccess.mockResolvedValue("no-doctor");
		await expect(doctorAccessFn()).resolves.toBe("no-doctor");
	});

	it("localeFn returns the request's active locale", async () => {
		mocks.getLocale.mockReturnValue("pt-BR");
		await expect(localeFn()).resolves.toBe("pt-BR");
	});

	it("clinicalPortalFn is null for anonymous visitors", async () => {
		mocks.getDoctorContext.mockResolvedValue(null);
		await expect(clinicalPortalFn()).resolves.toBeNull();
	});

	it("clinicalPortalFn sends own-profile accounts to the doctor portal", async () => {
		mocks.getDoctorContext.mockResolvedValue({
			profiles: [{ doctorId: 1, role: "owner" }],
			activeDoctorId: 1,
		});
		await expect(clinicalPortalFn()).resolves.toBe("doctor");
	});

	it("clinicalPortalFn sends delegated-only accounts to the secretary portal", async () => {
		mocks.getDoctorContext.mockResolvedValue({
			profiles: [{ doctorId: 2, role: "secretary" }],
			activeDoctorId: 2,
		});
		await expect(clinicalPortalFn()).resolves.toBe("secretary");
	});
});
