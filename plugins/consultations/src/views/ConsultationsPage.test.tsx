// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom lacks ResizeObserver + Web Animations — Base UI internals
// (Select positioner, PreviewCard) call them during mount/effects.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
Element.prototype.getAnimations ??= () => [];

const zkMocks = vi.hoisted(() => ({
	decryptConsultations: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../zk.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../zk.ts")>()),
	decryptConsultations: zkMocks.decryptConsultations,
}));
const routerMocks = vi.hoisted(() => ({
	navigate: vi.fn<(opts: { to: string }) => Promise<void>>(),
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
		useNavigate: () => routerMocks.navigate,
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

const SECTION_IDS = [
	"queixa_principal",
	"hda",
	"antecedentes",
	"alergias",
	"medicamentos_em_uso",
	"exame_fisico",
	"hipoteses",
	"conduta",
] as const;

/** Minimal valid anamnesis document as stored JSON — `baixa` marks that
 * many sections low-confidence; `queixa`/`conduta` override content. */
const anamnesisJson = ({
	baixa = 0,
	queixa = "Dor de cabeça",
	conduta = "Repouso",
}: {
	baixa?: number;
	queixa?: string;
	conduta?: string;
} = {}): string => {
	const doc: Record<string, { content: string; confidence: string; evidence: string[] }> = {};
	SECTION_IDS.forEach((key, i) => {
		doc[key] = {
			content: "texto",
			confidence: i < baixa ? "baixa" : "alta",
			evidence: [],
		};
	});
	doc.queixa_principal!.content = queixa;
	doc.conduta!.content = conduta;
	return JSON.stringify(doc);
};

afterEach(() => {
	cleanup();
	routerMocks.navigate.mockClear();
});

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

	it("renders the table column headers", () => {
		render(<ConsultationsPage consultations={[item({})]} />);
		expect(screen.getByRole("columnheader", { name: "Patient" })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Date" })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Anamnesis" })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Actions" })).toBeTruthy();
	});

	it("navigates to the consultation detail on row click", async () => {
		const user = userEvent.setup();
		render(<ConsultationsPage consultations={[item({})]} />);
		await user.click(screen.getByText("Dor de cabeça"));
		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/consultations/1" });
	});

	it("prefixes row navigation with portalBase", async () => {
		const user = userEvent.setup();
		render(<ConsultationsPage consultations={[item({})]} portalBase="/portal" />);
		await user.click(screen.getByText("Dor de cabeça"));
		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/portal/consultations/1" });
	});

	it("skips row navigation from interactive cells", async () => {
		const user = userEvent.setup();
		render(<ConsultationsPage consultations={[item({ patientId: 5 })]} />);
		await user.click(screen.getByText("Open"));
		expect(routerMocks.navigate).not.toHaveBeenCalled();
		await user.click(screen.getByText("Maria Silva"));
		expect(routerMocks.navigate).not.toHaveBeenCalled();
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
		expect(screen.getAllByText("Live now").length).toBeGreaterThan(0);
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

	it("renders locked rows with the lock hint and no actions", async () => {
		zkMocks.decryptConsultations.mockResolvedValueOnce([]);
		render(
			<ConsultationsPage
				consultations={[item({ id: 9, anamnesis: "v1.x.y", chiefComplaint: null })]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		await waitFor(() => expect(screen.getByText("Encrypted record")).toBeTruthy());
		expect(screen.getByText("Unlock it on an approved clinic device to view it.")).toBeTruthy();
		expect(screen.getByText("#9")).toBeTruthy();
		expect(screen.queryByText("Open")).toBeNull();
		expect(screen.queryByText("PDF")).toBeNull();
	});

	it("does not navigate locked rows under ZK", async () => {
		const user = userEvent.setup();
		zkMocks.decryptConsultations.mockResolvedValueOnce([]);
		render(
			<ConsultationsPage
				consultations={[item({ id: 42, anamnesis: "v1.x.y", chiefComplaint: null })]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		await user.click(screen.getByText("Encrypted record"));
		expect(routerMocks.navigate).not.toHaveBeenCalled();
	});

	it("hides search when list is empty", () => {
		render(<ConsultationsPage consultations={[]} />);
		expect(screen.queryByLabelText("Search consultations")).toBeNull();
	});

	it("filters by status through the select", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", status: "live" }),
					item({ id: 2, patientName: "Bia", status: "done" }),
				]}
			/>,
		);
		await user.click(screen.getByLabelText("All statuses"));
		await user.click(await screen.findByRole("option", { name: "Live" }));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.queryByText("Bia")).toBeNull();
		await user.click(screen.getByLabelText("All statuses"));
		await user.click(await screen.findByRole("option", { name: "Done" }));
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.getByText("Bia")).toBeTruthy();
		await user.click(screen.getByLabelText("All statuses"));
		await user.click(await screen.findByRole("option", { name: "All statuses" }));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bia")).toBeTruthy();
	});

	it("filters by source through the select", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", source: "browser" }),
					item({ id: 2, patientName: "Bia", source: "bot" }),
				]}
			/>,
		);
		await user.click(screen.getByLabelText("All sources"));
		await user.click(await screen.findByRole("option", { name: "Teleconsult (bot)" }));
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.getByText("Bia")).toBeTruthy();
		await user.click(screen.getByLabelText("All sources"));
		await user.click(await screen.findByRole("option", { name: "Dictation" }));
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.queryByText("Bia")).toBeNull();
		expect(screen.getByText(/No consultations match/)).toBeTruthy();
		await user.click(screen.getByLabelText("All sources"));
		await user.click(await screen.findByRole("option", { name: "All sources" }));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bia")).toBeTruthy();
	});

	it("filters by anamnesis presence through the select", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", hasAnamnesis: true }),
					item({ id: 2, patientName: "Bia", hasAnamnesis: false }),
				]}
			/>,
		);
		await user.click(screen.getByLabelText("Any anamnesis"));
		await user.click(await screen.findByRole("option", { name: "With anamnesis" }));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.queryByText("Bia")).toBeNull();
		await user.click(screen.getByLabelText("Any anamnesis"));
		await user.click(await screen.findByRole("option", { name: "Without anamnesis" }));
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.getByText("Bia")).toBeTruthy();
		await user.click(screen.getByLabelText("Any anamnesis"));
		await user.click(await screen.findByRole("option", { name: "Any anamnesis" }));
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bia")).toBeTruthy();
	});

	it("renders a pulsing live badge for live rows", () => {
		const { container } = render(<ConsultationsPage consultations={[item({ status: "live" })]} />);
		const dot = container.querySelector(".animate-pulse");
		expect(dot).not.toBeNull();
		expect(dot!.parentElement!.textContent).toContain("Live now");
	});

	it("shows the needs-review badge with the baixa-section count", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", anamnesis: anamnesisJson({ baixa: 2 }) }),
					item({ id: 2, patientName: "Bia", anamnesis: anamnesisJson({ baixa: 1 }) }),
					item({ id: 3, patientName: "Cid", anamnesis: anamnesisJson() }),
				]}
			/>,
		);
		expect(screen.getByText("2 sections to review")).toBeTruthy();
		expect(screen.getByText("1 section to review")).toBeTruthy();
		const cidRow = screen.getByText("Cid").closest("tr")!;
		expect(within(cidRow).queryByText(/to review/)).toBeNull();
	});

	it("treats malformed or absent anamnesis JSON as no review data", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({ id: 1, patientName: "Ana", anamnesis: "{not json" }),
					item({ id: 2, patientName: "Bia", anamnesis: JSON.stringify({ foo: 1 }) }),
					item({ id: 3, patientName: "Cid" }),
				]}
			/>,
		);
		expect(screen.queryByText(/to review/)).toBeNull();
		expect(document.querySelector('[data-slot="hover-card-trigger"]')).toBeNull();
	});

	it("never parses ciphered rows for badges or previews under ZK", async () => {
		zkMocks.decryptConsultations.mockResolvedValueOnce([]);
		render(
			<ConsultationsPage
				consultations={[item({ id: 9, anamnesis: "v1.x.y", chiefComplaint: null })]}
				zk={{ keyring: {}, api: {} } as never}
			/>,
		);
		await waitFor(() => expect(screen.getByText("Encrypted record")).toBeTruthy());
		expect(screen.queryByText(/to review/)).toBeNull();
		expect(document.querySelector('[data-slot="hover-card-trigger"]')).toBeNull();
	});

	it("enables previews and review badges for decrypted ZK rows", async () => {
		const ciphered = item({ id: 1, anamnesis: "v1.x.y", chiefComplaint: null });
		zkMocks.decryptConsultations.mockResolvedValueOnce([
			{ ...ciphered, anamnesis: anamnesisJson({ baixa: 2 }) },
		]);
		render(<ConsultationsPage consultations={[ciphered]} zk={{ keyring: {}, api: {} } as never} />);
		await waitFor(() =>
			expect(document.querySelector('[data-slot="hover-card-trigger"]')).not.toBeNull(),
		);
		expect(screen.getByText("2 sections to review")).toBeTruthy();
	});

	it("shows the anamnesis preview on hover", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({
						anamnesis: anamnesisJson({
							queixa: "Dor intensa",
							conduta: "Repouso e hidratação",
						}),
					}),
				]}
			/>,
		);
		const trigger = document.querySelector('[data-slot="hover-card-trigger"]')!;
		await user.hover(trigger);
		expect(await screen.findByText("Chief complaint", {}, { timeout: 3000 })).toBeTruthy();
		expect(screen.getByText("Dor intensa")).toBeTruthy();
		expect(screen.getByText("Plan")).toBeTruthy();
		expect(screen.getByText("Repouso e hidratação")).toBeTruthy();
	});

	it("truncates long preview sections and dashes empty ones", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationsPage
				consultations={[
					item({
						anamnesis: anamnesisJson({ queixa: "x".repeat(300), conduta: "" }),
					}),
				]}
			/>,
		);
		await user.hover(document.querySelector('[data-slot="hover-card-trigger"]')!);
		expect(await screen.findByText(`${"x".repeat(199)}…`, {}, { timeout: 3000 })).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("renders no hover preview for rows without a readable anamnesis", async () => {
		const user = userEvent.setup();
		render(<ConsultationsPage consultations={[item({ hasAnamnesis: false })]} />);
		expect(document.querySelector('[data-slot="hover-card-trigger"]')).toBeNull();
		await user.hover(screen.getByText("Maria Silva"));
		expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
	});

	it("keeps row navigation when the patient cell is a hover-card trigger", async () => {
		const user = userEvent.setup();
		render(<ConsultationsPage consultations={[item({ anamnesis: anamnesisJson() })]} />);
		await user.click(screen.getByText("Dor de cabeça"));
		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/consultations/1" });
	});

	it("shows the stats strip with today/live/review counts", () => {
		const now = new Date();
		const yesterday = new Date(now.getTime() - 86_400_000);
		render(
			<ConsultationsPage
				consultations={[
					item({
						id: 1,
						patientName: "Ana",
						createdAt: now,
						status: "live",
						anamnesis: anamnesisJson({ baixa: 3 }),
					}),
					item({ id: 2, patientName: "Bia", createdAt: yesterday }),
				]}
			/>,
		);
		const cards = document.querySelectorAll('[data-slot="card"]');
		expect(cards).toHaveLength(3);
		expect(cards[0]!.textContent).toContain("Today");
		expect(cards[0]!.querySelector("span")!.textContent).toBe("1");
		expect(cards[1]!.textContent).toContain("Live now");
		expect(cards[1]!.querySelector("span")!.textContent).toBe("1");
		expect(cards[2]!.textContent).toContain("Needs review");
		expect(cards[2]!.querySelector("span")!.textContent).toBe("1");
	});

	it("shows zeros in the stats strip when nothing matches", () => {
		render(
			<ConsultationsPage
				consultations={[
					item({
						createdAt: new Date("2020-01-01T10:00:00"),
						anamnesis: anamnesisJson(),
					}),
				]}
			/>,
		);
		const cards = document.querySelectorAll('[data-slot="card"]');
		expect(cards).toHaveLength(3);
		for (const card of cards) {
			expect(card.querySelector("span")!.textContent).toBe("0");
		}
	});
});
