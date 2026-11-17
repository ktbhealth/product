// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	props: { current: undefined as Record<string, unknown> | undefined },
	registerPortalDevice: vi.fn(async () => {}),
	decryptPortalConsultation: vi.fn(),
}));

vi.mock("./PortalConsultationPage.tsx", () => ({
	PortalConsultationPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "portal-consultation" });
	},
}));
vi.mock("../zk.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../zk.ts")>();
	return {
		...actual,
		registerPortalDevice: mocks.registerPortalDevice,
		decryptPortalConsultation: mocks.decryptPortalConsultation,
		portalZkApi: {},
	};
});

import { PatientPortalConsultationPage } from "./PatientPortalConsultationPage.tsx";

const ctx = { plugins: [], locale: "en" };
const consultation = {
	id: 10,
	createdAt: new Date(0),
	patientId: 1,
	patientName: "Ana",
	doctorName: "Dra. Bia",
	sections: [],
	anamnesis: null,
};
const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.props.current = undefined;
});

describe("PatientPortalConsultationPage", () => {
	it("maps loader data and ctx into the read-only view", () => {
		render(<PatientPortalConsultationPage data={{ view: "detail", consultation }} ctx={ctx} />);
		expect(captured()).toEqual({ consultation, locale: "en", locked: false });
		// Plaintext rows never touch the device keyring or the wire.
		expect(mocks.registerPortalDevice).not.toHaveBeenCalled();
		expect(mocks.decryptPortalConsultation).not.toHaveBeenCalled();
	});

	it("renders nothing for missing or unknown loader data", () => {
		const { container, unmount } = render(
			<PatientPortalConsultationPage data={undefined} ctx={ctx} />,
		);
		expect(container.innerHTML).toBe("");
		unmount();
		render(<PatientPortalConsultationPage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("renders the locked card for a record this device cannot open", async () => {
		const ciphered = { ...consultation, patientName: "v1.name.ct", anamnesis: "v1.a.b" };
		// No grant reaches this device → the row comes back still ciphered.
		mocks.decryptPortalConsultation.mockImplementation(
			async (_k: unknown, _a: unknown, row: unknown) => row,
		);
		render(
			<PatientPortalConsultationPage data={{ view: "detail", consultation: ciphered }} ctx={ctx} />,
		);
		await waitFor(() => expect(mocks.decryptPortalConsultation).toHaveBeenCalled());
		expect(mocks.registerPortalDevice).toHaveBeenCalled();
		const props = captured() as {
			consultation: { patientName: string; anamnesis: string | null };
			locked: boolean;
		};
		expect(props.locked).toBe(true);
		expect(props.consultation.patientName).toBe("Encrypted record");
		expect(props.consultation.anamnesis).toBe("v1.a.b");
	});

	it("stays locked when the decrypt pass itself fails", async () => {
		const ciphered = { ...consultation, anamnesis: "v1.a.b" };
		mocks.decryptPortalConsultation.mockRejectedValue(new Error("down"));
		render(
			<PatientPortalConsultationPage data={{ view: "detail", consultation: ciphered }} ctx={ctx} />,
		);
		await waitFor(() => expect(mocks.decryptPortalConsultation).toHaveBeenCalled());
		await waitFor(() => expect(captured().locked).toBe(true));
	});

	it("does not set state after unmount", async () => {
		let resolve: ((row: unknown) => void) | undefined;
		mocks.decryptPortalConsultation.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const ciphered = { ...consultation, anamnesis: "v1.a.b" };
		const { unmount } = render(
			<PatientPortalConsultationPage data={{ view: "detail", consultation: ciphered }} ctx={ctx} />,
		);
		unmount();
		resolve?.(ciphered);
		await waitFor(() => expect(mocks.decryptPortalConsultation).toHaveBeenCalled());
	});
});
