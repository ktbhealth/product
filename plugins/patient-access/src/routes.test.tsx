// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

const mocks = vi.hoisted(() => ({
	doctorAccessFn: vi.fn(),
	clinicalPortalFn: vi.fn(),
}));

vi.mock("./fns.ts", () => ({
	doctorAccessFn: mocks.doctorAccessFn,
	clinicalPortalFn: mocks.clinicalPortalFn,
}));
// Server fns become plain async calls; with no runtime registered the
// plugin route gate (createPluginFileRoute → pluginEnabledFn) is inert.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
		}),
	};
});

import { isRedirect } from "@tanstack/react-router";

import { Route } from "./routes/$patientId.tsx";

const options = (
	Route as unknown as {
		options: {
			beforeLoad: (args: { params: { patientId: string } }) => Promise<void>;
			component: () => unknown;
		};
	}
).options;

const redirectTarget = async (run: () => Promise<unknown>) => {
	const caught = await run().catch((e: unknown) => e);
	expect(isRedirect(caught)).toBe(true);
	return caught as Response & { options: { to?: string; href?: string } };
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const beforeLoad = () => options.beforeLoad({ params: { patientId: "7" } });

describe("/patient-access/$patientId", () => {
	it("sends anonymous visitors to the doctor sign-in page", async () => {
		mocks.doctorAccessFn.mockResolvedValue("anonymous");
		const caught = await redirectTarget(beforeLoad);
		expect(caught.options.href).toBe("/login/doctor");
		expect(mocks.clinicalPortalFn).not.toHaveBeenCalled();
	});

	it("sends accounts with no doctor profile to the chooser", async () => {
		mocks.doctorAccessFn.mockResolvedValue("no-doctor");
		const caught = await redirectTarget(beforeLoad);
		expect(caught.options.to).toBe("/doctors/select");
		expect(mocks.clinicalPortalFn).not.toHaveBeenCalled();
	});

	it("lands own-profile accounts on the doctor instance page", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue("doctor");
		const caught = await redirectTarget(beforeLoad);
		expect(caught.options.href).toBe("/portal/doctor/patient-access/7");
	});

	it("lands delegated secretaries on their own instance", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue("secretary");
		const caught = await redirectTarget(beforeLoad);
		expect(caught.options.href).toBe("/portal/secretary/patient-access/7");
	});

	it("falls back to the doctor instance when the role is unresolved", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		mocks.clinicalPortalFn.mockResolvedValue(null);
		const caught = await redirectTarget(beforeLoad);
		expect(caught.options.href).toBe("/portal/doctor/patient-access/7");
	});

	it("renders nothing — the funnel lives in beforeLoad", () => {
		expect(options.component()).toBeNull();
	});
});
