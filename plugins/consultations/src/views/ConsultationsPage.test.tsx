// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const zkMocks = vi.hoisted(() => ({
	decryptConsultations: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../zk.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../zk.ts")>()),
	decryptConsultations: zkMocks.decryptConsultations,
}));

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: (props: Record<string, unknown>) =>
			React.createElement(
				"a",
				{ href: typeof props.to === "string" ? props.to : "#", ...props },
				props.children as never,
			),
	};
});

import { ConsultationsPage, type ConsultationListItem } from "./ConsultationsPage.tsx";

const BASE: ConsultationListItem = {
	id: 1,
	engine: "heuristic",
	createdAt: new Date("2026-11-06T14:30:00"),
	transcript: "Médico: oi\nPaciente: olá",
	source: "browser",
	status: "done",
	consentAt: new Date("2026-11-06T14:00:00"),
	patientName: "Maria Silva",
	chiefComplaint: "Dor de cabeça",
	hasAnamnesis: true,
};

const item = (over: Partial<ConsultationListItem>): ConsultationListItem => ({ ...BASE, ...over });

afterEach(cleanup);

describe("ConsultationsPage", () => {
	it("renders empty state", () => {
		render(<ConsultationsPage consultations={[]} />);
		expect(screen.getByText("No consultations yet.")).toBeTruthy();
		expect(screen.getByText("No consultations yet")).toBeTruthy();
		expect(screen.getByText("Start consultation")).toBeTruthy();
	});

	it("links to the patient record only for linked consultations", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientId: 5 }),
					item({ id: 2, patientId: null, patientName: null }),
				]}
			/>,
		);
		const links = screen.getAllByText("Patient record");
		expect(links).toHaveLength(1);
		expect(links[0]!.getAttribute("href")).toBe("/patients/5");
	});

	it("renders singular/plural count and list", () => {
		render(<ConsultationsPage consultations={[item({})]} />);
		expect(screen.getByText("1 consultation recorded.")).toBeTruthy();
		expect(screen.getByText("Maria Silva")).toBeTruthy();
		expect(screen.getByText("Dor de cabeça")).toBeTruthy();
	});

	it("renders badges for live/anamnesis/consent/source", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({
						status: "live",
						source: "bot",
						patientName: null,
						hasAnamnesis: false,
						consentAt: null,
					}),
				]}
			/>,
		);
		expect(screen.getByText("● live")).toBeTruthy();
		expect(screen.getByText("No anamnesis")).toBeTruthy();
		expect(screen.getByText("Teleconsult (bot)")).toBeTruthy();
		expect(screen.getByText("Unlinked patient")).toBeTruthy();
		expect(screen.getByText("Dor de cabeça")).toBeTruthy();
	});

	it("falls back to transcript when queixa is placeholder", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ chiefComplaint: "A preencher pelo médico", transcript: "fallback text" }),
				]}
			/>,
		);
		expect(screen.getByText("fallback text")).toBeTruthy();
	});

	it("shows 'No transcript' when no chiefComplaint and empty transcript", () => {
		render(<ConsultationsPage consultations={[item({ chiefComplaint: null, transcript: "" })]} />);
		expect(screen.getByText("No transcript.")).toBeTruthy();
	});

	it("shows PDF link only with anamnesis", () => {
		const { rerender } = render(
			<ConsultationsPage consultations={[item({ hasAnamnesis: true })]} />,
		);
		expect(screen.getByText("PDF")).toBeTruthy();
		rerender(<ConsultationsPage consultations={[item({ hasAnamnesis: false })]} />);
		expect(screen.queryByText("PDF")).toBeNull();
	});

	it("filters by search text across fields", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana" }),
					item({ id: 2, patientName: "Bia", chiefComplaint: "Tosse seca" }),
				]}
			/>,
		);
		const input = screen.getByLabelText("Search consultations");
		await user.type(input, "tosse");
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.getByText("Bia")).toBeTruthy();
		await user.clear(input);
		await user.type(input, "zzz-nada");
		expect(screen.getByText(/No consultations match/)).toBeTruthy();
	});

	it("filters by anamnesis/pending tabs", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", hasAnamnesis: true }),
					item({ id: 2, patientName: "Bia", hasAnamnesis: false }),
				]}
			/>,
		);
		await user.click(screen.getByText("With anamnesis"));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.queryByText("Bia")).toBeNull();
		await user.click(screen.getByText("Pending"));
		expect(screen.getByText("Bia")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
		await user.click(screen.getByText("All"));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bia")).toBeTruthy();
	});

	it("handles initials edge cases", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "  " }),
					item({ id: 2, patientName: "Single" }),
					item({ id: 3, patientName: "Um Dois Tres" }),
				]}
			/>,
		);
	});

	it("falls back to raw source label for unknown sources", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, source: "custom-source" }),
					item({ id: 2, source: null, patientName: "Bia" }),
				]}
			/>,
		);
		expect(screen.getByText("custom-source")).toBeTruthy();
	});

	it("prefixes internal links with portalBase", () => {
		const { container } = render(
			<ConsultationsPage consultations={[item({ patientId: 5 })]} portalBase="/portal" />,
		);
		expect(container.querySelector('a[href="/portal/patients/5"]')).not.toBeNull();
		expect(container.querySelector('a[href="/portal/consultations/1"]')).not.toBeNull();
		expect(container.querySelector('a[href="/portal/consultations/new"]')).not.toBeNull();
	});

	it("decrypts ciphered rows under ZK and derives the chief complaint", async () => {
		const doc = {
			queixa_principal: { content: "Dor aguda", confidence: "alta", evidence: ["x"] },
			hda: { content: "", confidence: "baixa", evidence: [] },
			antecedentes: { content: "", confidence: "baixa", evidence: [] },
			alergias: { content: "", confidence: "baixa", evidence: [] },
			medicamentos_em_uso: { content: "", confidence: "baixa", evidence: [] },
			exame_fisico: { content: "", confidence: "baixa", evidence: [] },
			hipoteses: { content: "", confidence: "baixa", evidence: [] },
			conduta: { content: "", confidence: "baixa", evidence: [] },
		};
		const ciphered = item({ id: 1, anamnesis: "v1.x.y", chiefComplaint: null });
		const locked = item({
			id: 2,
			anamnesis: "v1.locked.z",
			chiefComplaint: null,
			patientName: null,
			transcript: "",
		});
		const known = item({ id: 3, anamnesis: "v1.q.r", chiefComplaint: "Febre" });
		zkMocks.decryptConsultations.mockResolvedValueOnce([
			{ ...ciphered, anamnesis: JSON.stringify(doc) },
			locked,
			{ ...known, anamnesis: JSON.stringify(doc) },
		]);
		render(
			<ConsultationsPage
				consultations={[ciphered, locked, known]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		await waitFor(() => expect(screen.getByText("Dor aguda")).toBeTruthy());
		expect(screen.getByText("Febre")).toBeTruthy();
		expect(zkMocks.decryptConsultations).toHaveBeenCalledWith({}, {}, [ciphered, locked, known]);
	});

	it("ignores late ZK resolutions after unmount", async () => {
		let resolve: (rows: unknown[]) => void = () => {};
		zkMocks.decryptConsultations.mockImplementationOnce(
			() =>
				new Promise<unknown[]>((r) => {
					resolve = r;
				}),
		);
		const { unmount } = render(
			<ConsultationsPage
				consultations={[item({ anamnesis: "v1.x.y" })]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		unmount();
		await act(async () => {
			resolve([]);
		});
	});

	it("searches locked rows by id only under ZK", async () => {
		const user = userEvent.setup();
		zkMocks.decryptConsultations.mockResolvedValueOnce([]);
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 42, anamnesis: "v1.x.y", chiefComplaint: null }),
					item({ id: 7, patientName: "Ana" }),
				]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		const input = screen.getByLabelText("Search consultations");
		await user.type(input, "42");
		// The locked row matches by id; the plain row filters out.
		expect(screen.getByText("Encrypted record")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
	});

	it("keeps the list usable when ZK decryption fails", async () => {
		zkMocks.decryptConsultations.mockRejectedValueOnce(new Error("no key"));
		render(
			<ConsultationsPage
				consultations={[item({ id: 1, anamnesis: "v1.x.y", chiefComplaint: null })]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		await waitFor(() => expect(screen.getByText("Encrypted record")).toBeTruthy());
	});

	it("hides search when list is empty", () => {
		render(<ConsultationsPage consultations={[]} />);
		expect(screen.queryByLabelText("Search consultations")).toBeNull();
	});
});
