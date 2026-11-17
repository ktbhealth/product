// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectPatientFn: vi.fn<(arg: { data: number }) => Promise<{ ok: boolean }>>(async (_arg) => ({
		ok: true,
	})),
	invalidate: vi.fn<() => void>(),
	props: { current: undefined as Record<string, unknown> | undefined },
	registerPortalDevice: vi.fn(async () => {}),
	decryptPortalProfiles: vi.fn(),
	decryptPortalSummaries: vi.fn(),
}));

const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock("../fns.ts", () => ({
	selectPatientFn: mocks.selectPatientFn,
}));
vi.mock("./PortalPage.tsx", () => ({
	PortalPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "portal-page" });
	},
}));
vi.mock("../zk.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../zk.ts")>();
	return {
		...actual,
		registerPortalDevice: mocks.registerPortalDevice,
		decryptPortalProfiles: mocks.decryptPortalProfiles,
		decryptPortalSummaries: mocks.decryptPortalSummaries,
	};
});

import { PatientPortalHomePage } from "./PatientPortalHomePage.tsx";

const ctx = { plugins: [], locale: "en" };
const data = {
	view: "home",
	user: { name: "Ana", email: "ana@ktb.test" },
	awaitingInvites: 0,
	profiles: [{ patientId: 1 }],
	profile: { patientId: 1 },
	consultations: [{ id: 10 }],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.props.current = undefined;
});

describe("PatientPortalHomePage", () => {
	it("maps loader data and ctx into the portal view", () => {
		render(<PatientPortalHomePage data={data} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			user: { name: "Ana", email: "ana@ktb.test" },
			profiles: [{ patientId: 1 }],
			profile: { patientId: 1 },
			consultations: [{ id: 10 }],
			locale: "en",
		});
	});

	it("renders nothing for missing loader data", () => {
		const { container, unmount } = render(<PatientPortalHomePage data={null} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		unmount();
		render(<PatientPortalHomePage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("wires the profile switcher to the selection fn and reloads after a change", async () => {
		render(<PatientPortalHomePage data={data} ctx={ctx} />);
		await (captured().api as { select(id: number): Promise<unknown> }).select(2);
		expect(mocks.selectPatientFn).toHaveBeenCalledWith({ data: 2 });
		(captured().onChanged as () => void)();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});

	it("runs the client-side ZK pass when rows arrive as envelopes", async () => {
		const zkData = {
			...data,
			profiles: [{ patientId: 1, name: "v1.profile" }],
			profile: { patientId: 1, name: "v1.profile" },
			consultations: [{ id: 10, anamnesis: "v1.consult" }],
		};
		mocks.decryptPortalProfiles.mockImplementation(
			async (_keyring: unknown, _api: unknown, rows: { name: string }[]) =>
				rows.map((row) => ({ ...row, name: "Ana" })),
		);
		mocks.decryptPortalSummaries.mockImplementation(
			async (_keyring: unknown, _api: unknown, rows: { id: number }[]) =>
				rows.map((row) => ({ ...row, anamnesis: null, chiefComplaint: "Dor" })),
		);
		render(<PatientPortalHomePage data={zkData} ctx={ctx} />);
		await waitFor(() => expect(captured().profiles).toEqual([{ patientId: 1, name: "Ana" }]));
		expect(captured().profile).toMatchObject({ name: "Ana" });
		expect(captured().consultations).toEqual([{ id: 10, anamnesis: null, chiefComplaint: "Dor" }]);
		expect(mocks.registerPortalDevice).toHaveBeenCalledTimes(1);
	});

	it("falls back to the loader profile when decryption returns no rows", async () => {
		const zkData = {
			...data,
			profiles: [{ patientId: 1, name: "v1.profile" }],
			profile: { patientId: 1, name: "v1.profile" },
			consultations: [],
		};
		mocks.decryptPortalProfiles.mockResolvedValue([]);
		mocks.decryptPortalSummaries.mockResolvedValue([]);
		render(<PatientPortalHomePage data={zkData} ctx={ctx} />);
		await waitFor(() => expect(mocks.decryptPortalProfiles).toHaveBeenCalled());
		await waitFor(() =>
			// The loader profile is still an envelope, so `named` masks it
			// with the locked-record label rather than the raw ciphertext.
			expect(captured().profile).toMatchObject({ patientId: 1, name: "Encrypted record" }),
		);
	});

	it("drops the ZK pass result when the view unmounts first", async () => {
		const zkData = {
			...data,
			profiles: [{ patientId: 1, name: "v1.profile" }],
			profile: { patientId: 1, name: "v1.profile" },
		};
		const resolvers: Array<(rows: unknown[]) => void> = [];
		mocks.decryptPortalProfiles.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		);
		mocks.decryptPortalSummaries.mockResolvedValue([]);
		const view = render(<PatientPortalHomePage data={zkData} ctx={ctx} />);
		await waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
		view.unmount();
		for (const resolve of resolvers) resolve([]);
		await Promise.resolve();
	});

	it("keeps the loader rows when the ZK pass fails", async () => {
		const zkData = {
			...data,
			profiles: [{ patientId: 1, name: "v1.profile" }],
			profile: null,
			consultations: [{ id: 10, anamnesis: "v1.consult" }],
		};
		mocks.decryptPortalProfiles.mockRejectedValue(new Error("no device key"));
		render(<PatientPortalHomePage data={zkData} ctx={ctx} />);
		await waitFor(() => expect(mocks.decryptPortalProfiles).toHaveBeenCalled());
		// resolved stays null — the locked-label fallback renders instead.
		expect(captured().profiles).toEqual([{ patientId: 1, name: expect.any(String) }]);
		expect((captured().profiles as { name: string }[])[0]!.name).not.toBe("v1.profile");
	});
});
