import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	doctorContextFn: vi.fn(),
	selectDoctorFn: vi.fn(async (_arg: { data: number }) => ({ ok: true })),
	localeFn: vi.fn(async () => "pt-BR"),
}));

vi.mock("./fns.ts", () => ({
	doctorContextFn: mocks.doctorContextFn,
	selectDoctorFn: mocks.selectDoctorFn,
	localeFn: mocks.localeFn,
}));
// Server fns become plain async calls; with no runtime registered the
// plugin route gate (createPluginFileRoute → pluginEnabledFn) is inert.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((value: unknown) => unknown) | undefined;
		const api = {
			validator: (fn: (value: unknown) => unknown) => {
				validate = fn;
				return api;
			},
			handler: (h: (arg: { data: unknown }) => unknown) => async (call: { data?: unknown }) =>
				h({ data: validate === undefined ? call?.data : validate(call?.data) }),
		};
		return api;
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
	};
});

import { isRedirect } from "@tanstack/react-router";

import { Route } from "./routes/select.tsx";

const options = (
	Route as unknown as {
		options: { loader: () => Promise<unknown>; component: () => unknown };
	}
).options;

type RedirectTarget = Response & { options: { href?: string; to?: string } };
const redirectedTo = async (): Promise<RedirectTarget> => {
	const caught = await options.loader().catch((e: unknown) => e);
	expect(isRedirect(caught)).toBe(true);
	return caught as RedirectTarget;
};

describe("/doctors/select", () => {
	it("sends anonymous visitors to the doctor sign-in", async () => {
		mocks.doctorContextFn.mockResolvedValue(null);
		expect((await redirectedTo()).options.href).toBe("/login/doctor");
	});

	it("sends an account with no doctor profile to the patient portal", async () => {
		mocks.doctorContextFn.mockResolvedValue({ profiles: [], activeDoctorId: null });
		expect((await redirectedTo()).options.to).toBe("/portal/patient");
	});

	it("sends an owning account to the doctor portal", async () => {
		mocks.doctorContextFn.mockResolvedValue({
			profiles: [
				{ doctorId: 1, role: "owner" },
				{ doctorId: 2, role: "secretary" },
			],
			activeDoctorId: 1,
		});
		expect((await redirectedTo()).options.href).toBe("/portal/doctor");
	});

	it("sends a delegated-only account to the secretary portal", async () => {
		mocks.doctorContextFn.mockResolvedValue({
			profiles: [{ doctorId: 2, role: "secretary" }],
			activeDoctorId: 2,
		});
		expect((await redirectedTo()).options.href).toBe("/portal/secretary");
	});

	it("renders nothing — the funnel lives in the loader", () => {
		expect(options.component()).toBeNull();
	});
});
