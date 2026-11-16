// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	portalFn: vi.fn(),
	portalConsultationFn: vi.fn(),
	patientActivityFn: vi.fn(async (): Promise<unknown> => ({
		entries: [],
		total: 0,
		limit: 100,
	})),
	portalDekEnvelopesFn: vi.fn(async () => ({})),
	portalRegisterDeviceFn: vi.fn(async () => ({ ok: true })),
	selectPatientFn: vi.fn(async (_arg: { data: number }) => ({ ok: true })),
	localeFn: vi.fn(async () => "pt-BR"),
	invalidate: vi.fn(),
	loaderData: { current: undefined as unknown },
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("./fns.ts", () => ({
	portalFn: mocks.portalFn,
	portalConsultationFn: mocks.portalConsultationFn,
	patientActivityFn: mocks.patientActivityFn,
	portalDekEnvelopesFn: mocks.portalDekEnvelopesFn,
	portalRegisterDeviceFn: mocks.portalRegisterDeviceFn,
	selectPatientFn: mocks.selectPatientFn,
	localeFn: mocks.localeFn,
}));
vi.mock("./views/index.ts", () => {
	const capture = (testId: string) => (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": testId });
	};
	return {
		PortalPage: capture("portal"),
		PortalConsultationPage: capture("consultation"),
		PortalActivityPage: capture("activity"),
	};
});
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
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
		}),
		useRouter: () => ({ invalidate: mocks.invalidate }),
	};
});

import { isNotFound, isRedirect } from "@tanstack/react-router";

import { Route as ActivityRoute } from "./routes/activity.tsx";
import { Route as ConsultationRoute } from "./routes/consultations.$id.tsx";
import { Route as HomeRoute } from "./routes/index.tsx";

type Options<LoaderArgs> = {
	loader: (args: LoaderArgs) => Promise<unknown>;
	component: () => ReactElement;
};
const home = (HomeRoute as unknown as { options: Options<void> }).options;
const activity = (ActivityRoute as unknown as { options: Options<void> }).options;
const detail = (ConsultationRoute as unknown as { options: Options<{ params: { id: string } }> })
	.options;

const redirectTarget = (caught: unknown) =>
	(caught as Response & { options: { to: string } }).options.to;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("/portal", () => {
	const portal = {
		user: { name: "Ana", email: "ana@ktb.test" },
		awaitingInvites: 0,
		profiles: [{ patientId: 1 }],
		profile: { patientId: 1 },
		consultations: [{ id: 10 }],
	};

	it("loads the portal with the locale", async () => {
		mocks.portalFn.mockResolvedValue(portal);
		await expect(home.loader()).resolves.toEqual({ ...portal, locale: "pt-BR" });
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalFn.mockResolvedValue(null);
		const caught = await home.loader().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectTarget(caught)).toBe("/portal/login");
	});

	it("wires the view to the server fns and reloads after a change", async () => {
		mocks.loaderData.current = { ...portal, locale: "en" };
		render(createElement(home.component));
		const props = mocks.props.current as {
			api: { select(id: number): Promise<unknown> };
			onChanged(): void;
		};
		expect(props).toMatchObject({ ...portal, locale: "en" });
		await props.api.select(2);
		expect(mocks.selectPatientFn).toHaveBeenCalledWith({ data: 2 });
		props.onChanged();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});

	it("registers the device and keeps locked rows behind the locked label", async () => {
		// ZK rows: no grant reaches this device → envelopes stay opaque.
		mocks.loaderData.current = {
			...portal,
			profiles: [{ patientId: 1, name: "v1.name.ct" }],
			profile: { patientId: 1, name: "v1.name.ct" },
			consultations: [
				{ id: 10, createdAt: new Date(0), chiefComplaint: null, anamnesis: "v1.a.b" },
			],
			locale: "en",
		};
		render(createElement(home.component));
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
		const props = mocks.props.current as {
			profiles: { name: string }[];
			profile: { name: string } | null;
			consultations: { anamnesis: string | null }[];
		};
		expect(mocks.portalRegisterDeviceFn).toHaveBeenCalled();
		expect(props.profiles[0]!.name).toBe("Encrypted record");
		expect(props.profile!.name).toBe("Encrypted record");
		expect(props.consultations[0]!.anamnesis).toBe("v1.a.b");
	});

	it("keeps locked labels when the decrypt pass itself fails", async () => {
		mocks.loaderData.current = {
			...portal,
			profiles: [{ patientId: 1, name: "v1.name.ct" }],
			profile: null,
			consultations: [],
			locale: "en",
		};
		mocks.portalDekEnvelopesFn.mockRejectedValue(new Error("down"));
		render(createElement(home.component));
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
		const props = mocks.props.current as { profiles: { name: string }[] };
		expect(props.profiles[0]!.name).toBe("Encrypted record");
	});

	it("still runs the decrypt pass when no record is open", async () => {
		mocks.loaderData.current = {
			...portal,
			profiles: [{ patientId: 1, name: "v1.name.ct" }],
			profile: null,
			consultations: [],
			locale: "en",
		};
		render(createElement(home.component));
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
		expect((mocks.props.current as { profile: unknown }).profile).toBeNull();
	});

	it("does not set state after unmount", async () => {
		let resolve: ((value: Record<string, string>) => void) | undefined;
		mocks.portalDekEnvelopesFn.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		mocks.loaderData.current = {
			...portal,
			profiles: [{ patientId: 1, name: "v1.name.ct" }],
			consultations: [],
			locale: "en",
		};
		const { unmount } = render(createElement(home.component));
		unmount();
		resolve?.({});
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
	});
});

describe("/portal/consultations/$id", () => {
	const consultation = { id: 10, patientName: "Ana", sections: [] };
	const load = () => detail.loader({ params: { id: "10" } });

	it("loads the consultation with the locale", async () => {
		mocks.portalConsultationFn.mockResolvedValue({ status: "ok", consultation });
		await expect(load()).resolves.toEqual({ consultation, locale: "pt-BR" });
		expect(mocks.portalConsultationFn).toHaveBeenCalledWith({ data: 10 });
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalConsultationFn.mockResolvedValue({ status: "anonymous" });
		const caught = await load().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectTarget(caught)).toBe("/portal/login");
	});

	it("is a 404 for a consultation the user may not see", async () => {
		mocks.portalConsultationFn.mockResolvedValue({ status: "missing" });
		expect(isNotFound(await load().catch((e: unknown) => e))).toBe(true);
	});

	it("renders the read-only view — no server actions are wired", () => {
		mocks.loaderData.current = { consultation, locale: "en" };
		render(createElement(detail.component));
		expect(mocks.props.current).toEqual({ consultation, locale: "en", locked: false });
	});

	it("renders the locked card for a record this device cannot open", async () => {
		const ciphered = {
			...consultation,
			patientName: "v1.name.ct",
			anamnesis: "v1.a.b",
		};
		mocks.loaderData.current = { consultation: ciphered, locale: "en" };
		render(createElement(detail.component));
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
		expect(mocks.portalRegisterDeviceFn).toHaveBeenCalled();
		const props = mocks.props.current as {
			consultation: { patientName: string; anamnesis: string | null };
			locked: boolean;
		};
		expect(props.locked).toBe(true);
		expect(props.consultation.patientName).toBe("Encrypted record");
		expect(props.consultation.anamnesis).toBe("v1.a.b");
	});

	it("stays locked when the decrypt pass itself fails", async () => {
		const ciphered = { ...consultation, anamnesis: "v1.a.b" };
		mocks.loaderData.current = { consultation: ciphered, locale: "en" };
		mocks.portalDekEnvelopesFn.mockRejectedValue(new Error("down"));
		render(createElement(detail.component));
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
		expect((mocks.props.current as { locked: boolean }).locked).toBe(true);
	});

	it("does not set state after unmount", async () => {
		let resolve: ((value: Record<string, string>) => void) | undefined;
		mocks.portalDekEnvelopesFn.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		mocks.loaderData.current = {
			consultation: { ...consultation, anamnesis: "v1.a.b" },
			locale: "en",
		};
		const { unmount } = render(createElement(detail.component));
		unmount();
		resolve?.({});
		await vi.waitFor(() => expect(mocks.portalDekEnvelopesFn).toHaveBeenCalled());
	});
});

describe("/portal/activity", () => {
	const portal = {
		user: { name: "Ana", email: "ana@ktb.test" },
		awaitingInvites: 0,
		profiles: [{ patientId: 1 }],
		profile: { patientId: 1 },
		consultations: [],
	};
	const feed = { entries: [{ id: 7 }], total: 1, limit: 100 };

	it("loads the open record's feed with the locale", async () => {
		mocks.portalFn.mockResolvedValue(portal);
		mocks.patientActivityFn.mockResolvedValue(feed);
		await expect(activity.loader()).resolves.toEqual({ activity: feed, locale: "pt-BR" });
		expect(mocks.patientActivityFn).toHaveBeenCalledWith({ data: { patientId: 1 } });
	});

	it("renders an empty page without calling the fn when no record is open", async () => {
		mocks.portalFn.mockResolvedValue({ ...portal, profile: null });
		await expect(activity.loader()).resolves.toEqual({
			activity: { entries: [], total: 0, limit: 100 },
			locale: "pt-BR",
		});
		expect(mocks.patientActivityFn).not.toHaveBeenCalled();
	});

	it("sends anonymous visitors to the patient sign-in page", async () => {
		mocks.portalFn.mockResolvedValue(null);
		const caught = await activity.loader().catch((e: unknown) => e);
		expect(isRedirect(caught)).toBe(true);
		expect(redirectTarget(caught)).toBe("/portal/login");
	});

	it("hands the feed and locale to the activity view", () => {
		mocks.loaderData.current = { activity: feed, locale: "en" };
		render(createElement(activity.component));
		expect(mocks.props.current).toEqual({ data: feed, locale: "en" });
	});
});
