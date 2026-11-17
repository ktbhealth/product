import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	portalSessionFn: vi.fn(async () => ({ signedIn: true })),
}));

vi.mock("./fns.ts", () => ({
	portalSessionFn: mocks.portalSessionFn,
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
// createFileRoute only captures the options object so the test can
// invoke beforeLoad directly.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
	};
});

import { isRedirect } from "@tanstack/react-router";

import { Route as ActivityRoute } from "./routes/activity.tsx";
import { Route as ConsultationRoute } from "./routes/consultations.$id.tsx";
import { Route as HomeRoute } from "./routes/index.tsx";

const home = (HomeRoute as unknown as { options: { beforeLoad: () => Promise<unknown> } }).options;
const activity = (ActivityRoute as unknown as { options: { beforeLoad: () => Promise<unknown> } })
	.options;
const detail = (
	ConsultationRoute as unknown as {
		options: { beforeLoad: (args: { params: { id: string } }) => Promise<unknown> };
	}
).options;

const componentOf = (route: unknown) =>
	(route as { options: { component: () => unknown } }).options.component;

const redirectHref = (caught: unknown) =>
	(caught as Response & { options: { href: string } }).options.href;

afterEach(() => {
	vi.clearAllMocks();
	mocks.portalSessionFn.mockResolvedValue({ signedIn: true });
});

describe("/portal redirect", () => {
	it("sends signed-in visitors to the patient instance", async () => {
		const caught = await home.beforeLoad().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/portal/patient");
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalSessionFn.mockResolvedValue({ signedIn: false });
		const caught = await home.beforeLoad().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/login/patient");
	});
});

describe("/portal/consultations/$id redirect", () => {
	const load = () => detail.beforeLoad({ params: { id: "10" } });

	it("sends signed-in visitors to the instance twin of the link", async () => {
		const caught = await load().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/portal/patient/consultations/10");
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalSessionFn.mockResolvedValue({ signedIn: false });
		const caught = await load().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/login/patient");
	});
});

describe("/portal/activity redirect", () => {
	it("sends signed-in visitors to the instance activity page", async () => {
		const caught = await activity.beforeLoad().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/portal/patient/activity");
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalSessionFn.mockResolvedValue({ signedIn: false });
		const caught = await activity.beforeLoad().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectHref(caught)).toBe("/login/patient");
	});
});

describe("legacy route components", () => {
	it("render nothing — the funnel lives in beforeLoad", () => {
		for (const route of [HomeRoute, ActivityRoute, ConsultationRoute]) {
			expect(componentOf(route)()).toBeNull();
		}
	});
});
