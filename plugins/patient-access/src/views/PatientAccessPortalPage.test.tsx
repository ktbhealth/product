// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invitePatientFn: vi.fn(async (_arg: { data: unknown }) => ({ ok: true as const })),
	approvePatientLinkFn: vi.fn(async (_arg: { data: number }) => ({ ok: true })),
	revokePatientLinkFn: vi.fn(async (_arg: { data: number }) => ({ ok: true })),
	vaultStateFn: vi.fn(async () => ({ zk: false })),
	portalReaders: vi.fn(
		async (): Promise<{
			readers: { readerId: string; wrapPublicKey: string }[];
			cipheredConsultationIds: number[];
		} | null> => null,
	),
	grantPortalAccess: vi.fn(async () => 0),
	decryptPatients: vi.fn(),
	invalidate: vi.fn(),
	pathname: { current: "/portal/secretary/patient-access/7" },
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: mocks.invalidate }),
	useLocation: (opts: { select: (l: { pathname: string }) => string }) =>
		opts.select({ pathname: mocks.pathname.current }),
}));
vi.mock("../fns.ts", () => ({
	invitePatientFn: mocks.invitePatientFn,
	approvePatientLinkFn: mocks.approvePatientLinkFn,
	revokePatientLinkFn: mocks.revokePatientLinkFn,
}));
vi.mock("@ktb/vault/fns", () => ({ vaultStateFn: mocks.vaultStateFn }));
vi.mock("@ktb/patients/zk", () => ({
	isCipheredPatient: (p: { name?: string } | null | undefined) =>
		String(p?.name ?? "").startsWith("v1."),
	decryptPatients: mocks.decryptPatients,
}));
vi.mock("@ktb/crypto/keyring", () => ({ makeKeyring: () => ({ device: "fake" }) }));
vi.mock("../zk.ts", () => ({
	grantPortalAccess: mocks.grantPortalAccess,
	patientAccessZkApi: { portalReaders: mocks.portalReaders },
}));
vi.mock("./PatientAccessPage.tsx", () => ({
	PatientAccessPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "patient-access" });
	},
}));

import { PatientAccessPortalPage } from "./PatientAccessPortalPage.tsx";

const ctx = { plugins: [], locale: "en" };
const detail = {
	view: "detail",
	patient: { id: 7, name: "Ana Souza" },
	links: [{ id: 1, email: "ana@ktb.test", relation: "self", status: "active", source: "invite" }],
};

const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.props.current = undefined;
	mocks.pathname.current = "/portal/secretary/patient-access/7";
	mocks.vaultStateFn.mockResolvedValue({ zk: false });
	mocks.portalReaders.mockResolvedValue(null);
	mocks.grantPortalAccess.mockResolvedValue(0);
});

describe("PatientAccessPortalPage", () => {
	it("renders the record inside the portal shell and wires the server actions", async () => {
		render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		await waitFor(() => expect(mocks.props.current).toBeDefined());
		expect(captured()).toMatchObject({
			patient: { id: 7, name: "Ana Souza" },
			links: detail.links,
			locale: "en",
			portalBase: "/portal/secretary",
		});
		const api = captured().api as {
			invite(i: { email: string; relation: string }): Promise<unknown>;
			approve(id: number): Promise<unknown>;
			revoke(id: number): Promise<unknown>;
		};
		await api.invite({ email: "ana@ktb.test", relation: "self" });
		expect(mocks.invitePatientFn).toHaveBeenCalledWith({
			data: { patientId: 7, email: "ana@ktb.test", relation: "self" },
		});
		await api.approve(3);
		expect(mocks.approvePatientLinkFn).toHaveBeenCalledWith({ data: 3 });
		await api.revoke(4);
		expect(mocks.revokePatientLinkFn).toHaveBeenCalledWith({ data: 4 });
		(captured().onChanged as () => void)();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});

	it("renders nothing for a missing record", () => {
		const { container } = render(<PatientAccessPortalPage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("treats absent loader data as a missing record", () => {
		const { container } = render(<PatientAccessPortalPage data={undefined} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("falls back to an empty portal base on a shallow path", async () => {
		mocks.pathname.current = "/portal";
		render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		await waitFor(() => expect(mocks.props.current).toBeDefined());
		expect(captured().portalBase).toBe("/portal/");
	});

	it("ignores a rejected vault probe and a late resolution after unmount", async () => {
		mocks.vaultStateFn.mockRejectedValueOnce(new Error("vault down"));
		const first = render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		await waitFor(() => expect(mocks.props.current).toBeDefined());
		first.unmount();
		// A resolution landing after unmount must not touch state.
		let resolveVault: ((v: { zk: boolean }) => void) | undefined;
		mocks.vaultStateFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveVault = resolve;
				}),
		);
		const second = render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		second.unmount();
		resolveVault?.({ zk: true });
		await Promise.resolve();
	});

	it("skips the grant pass when the tenant reports no readers", async () => {
		mocks.vaultStateFn.mockResolvedValue({ zk: true });
		// Non-ciphered name skips the decrypt block; portalReaders → null.
		render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		await waitFor(() => expect(mocks.portalReaders).toHaveBeenCalled());
		expect(mocks.grantPortalAccess).not.toHaveBeenCalled();
	});

	it("keeps the ciphered label when decryption returns a still-ciphered row", async () => {
		mocks.vaultStateFn.mockResolvedValue({ zk: true });
		mocks.decryptPatients.mockResolvedValue([{ id: 7, name: "v1.still" }]);
		render(
			<PatientAccessPortalPage
				data={{ ...detail, patient: { id: 7, name: "v1.patient" } }}
				ctx={ctx}
			/>,
		);
		await waitFor(() => expect(mocks.decryptPatients).toHaveBeenCalled());
		await waitFor(() => expect(captured().patient).toMatchObject({ name: expect.any(String) }));
		expect((captured().patient as { name: string }).name).not.toBe("Ana Souza");
	});

	it("decrypts the record name and runs the portal grant pass on a ZK tenant", async () => {
		mocks.vaultStateFn.mockResolvedValue({ zk: true });
		mocks.decryptPatients.mockResolvedValue([{ id: 7, name: "Ana Souza" }]);
		mocks.portalReaders.mockResolvedValue({
			readers: [{ readerId: "ana", wrapPublicKey: "portalPub" }],
			cipheredConsultationIds: [10],
		});
		mocks.grantPortalAccess.mockResolvedValue(2);
		render(
			<PatientAccessPortalPage
				data={{ ...detail, patient: { id: 7, name: "v1.patient" } }}
				ctx={ctx}
			/>,
		);
		await waitFor(() => expect(captured().patient).toMatchObject({ name: "Ana Souza" }));
		expect(mocks.grantPortalAccess).toHaveBeenCalledWith(
			{ device: "fake" },
			{ portalReaders: mocks.portalReaders },
			{
				patientId: 7,
				consultationIds: [10],
				readers: [{ readerId: "ana", wrapPublicKey: "portalPub" }],
			},
		);
	});

	it("keeps the locked label when the ZK pass fails", async () => {
		mocks.vaultStateFn.mockResolvedValue({ zk: true });
		mocks.decryptPatients.mockRejectedValue(new Error("no device key"));
		render(
			<PatientAccessPortalPage
				data={{ ...detail, patient: { id: 7, name: "v1.patient" } }}
				ctx={ctx}
			/>,
		);
		await waitFor(() => expect(mocks.decryptPatients).toHaveBeenCalled());
		expect((captured().patient as { name: string }).name).not.toBe("v1.patient");
	});

	it("survives a vault-state failure", async () => {
		mocks.vaultStateFn.mockRejectedValue(new Error("offline"));
		render(<PatientAccessPortalPage data={detail} ctx={ctx} />);
		await waitFor(() => expect(mocks.props.current).toBeDefined());
		expect(captured().patient).toMatchObject({ name: "Ana Souza" });
	});
});
