import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	getDoctorAccess: vi.fn(),
	getDoctorContext: vi.fn(),
	getLocale: vi.fn(() => "pt-BR"),
}));

// Same fake as the host's route tests: the handler runs as a plain async fn.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: (h: (arg?: unknown) => unknown) => async (arg?: unknown) => h(arg ?? {}),
		};
		return chain;
	},
}));
vi.mock("@ktb/server-fns", async (importOriginal) => ({
	...(await importOriginal<typeof import("@ktb/server-fns")>()),
	getSessionUser: mocks.getSessionUser,
	getDoctorAccess: mocks.getDoctorAccess,
	getDoctorContext: mocks.getDoctorContext,
	getLocale: mocks.getLocale,
}));

import { clinicalPortalFn, doctorAccessFn, localeFn, sessionUserFn } from "./fns.ts";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("session server fns", () => {
	it("sessionUserFn returns the signed-in user", async () => {
		const user = { id: "u1", email: "a@x.com", name: "A" };
		mocks.getSessionUser.mockResolvedValue(user);
		await expect(sessionUserFn()).resolves.toBe(user);
	});

	it("doctorAccessFn returns the request's doctor-side standing", async () => {
		mocks.getDoctorAccess.mockResolvedValue("anonymous");
		await expect(doctorAccessFn()).resolves.toBe("anonymous");
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

	it("localeFn returns the request locale", async () => {
		await expect(localeFn()).resolves.toBe("pt-BR");
		expect(mocks.getLocale).toHaveBeenCalled();
	});
});
