// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
	navigate: vi.fn<() => void>(),
	invalidate: vi.fn<() => void>(),
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
		useRouter: () => ({ invalidate: routerMocks.invalidate }),
	};
});

import type { Anamnesis } from "@ktb/anamnesis";
import type { ConsultationDetail, ConsultationDetailApi } from "./ConsultationDetailPage.tsx";
import type { ConsultationListItem } from "./ConsultationsPage.tsx";
import { serializeTranscriptSegments } from "../segments.ts";
import { ReviewModePage } from "./ReviewModePage.tsx";

const SECTION = { content: "", confidence: "alta" as const, evidence: [] as string[] };
const ANAMNESIS: Anamnesis = {
	historico: SECTION,
	queixa_principal: {
		content: "Dor de garganta",
		confidence: "alta",
		evidence: ["dor de garganta"],
	},
	hda: { content: "HDA", confidence: "baixa", evidence: ["há três dias"] },
	antecedentes: SECTION,
	alergias: SECTION,
	medicamentos_em_uso: SECTION,
	exame_fisico: SECTION,
	hipoteses: SECTION,
	conduta: SECTION,
};

const SEGMENTS = [
	{ start: 0, end: 2.5, text: "Bom dia, como está?", avgLogprob: -0.1 },
	{ start: 2.5, end: 5, text: "Dor de garganta há três dias", avgLogprob: -0.9 },
	{ start: 5, end: 8, text: "Vou examinar agora.", avgLogprob: -0.2 },
];

const DETAIL: ConsultationDetail = {
	id: 10,
	userId: "u1",
	patientId: 1,
	botId: null,
	createdAt: new Date("2026-11-06T14:30:00"),
	transcript: "Bom dia, como está? Dor de garganta há três dias Vou examinar agora.",
	source: "browser",
	status: "done",
	engine: null,
	patientName: "Lívia",
	consentAt: null,
	anamnesis: ANAMNESIS,
	audioKey: "k10",
	audioStatus: "done",
	audioError: null,
	serverTranscript: "Bom dia, como está? Dor de garganta há três dias Vou examinar agora.",
	correctedTranscript: null,
	enhancementEngine: null,
	transcriptSegments: serializeTranscriptSegments(SEGMENTS),
};

const detail = (over: Partial<ConsultationDetail>): ConsultationDetail => ({
	...DETAIL,
	...over,
});

const QUEUE_BASE: ConsultationListItem = {
	id: 10,
	engine: null,
	createdAt: new Date("2026-11-06T14:30:00"),
	transcript: "t",
	source: null,
	status: "done",
	consentAt: null,
	patientName: "Lívia",
	chiefComplaint: null,
	hasAnamnesis: true,
	anamnesisVersion: 1,
};
const item = (over: Partial<ConsultationListItem>): ConsultationListItem => ({
	...QUEUE_BASE,
	...over,
});

const api = (over: Partial<ConsultationDetailApi> = {}): ConsultationDetailApi => ({
	getConsultation: vi.fn(async (): Promise<null> => null),
	reviewTranscript: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
	approveAnamnesis: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
	saveTranscriptEdits: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
	deferConsultation: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
	nextPendingReview: vi.fn(async (): Promise<{ id: number | null }> => ({ id: null })),
	generateAnamnesis: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
	...over,
});

const renderPage = (
	props: Partial<Parameters<typeof ReviewModePage>[0]> = {},
	queue: ConsultationListItem[] = [item({})],
	c: ConsultationDetail | null = DETAIL,
) =>
	render(
		<ReviewModePage
			queue={queue}
			c={c}
			author="u1"
			api={api()}
			portalBase="/portal/doctor"
			{...props}
		/>,
	);

beforeEach(() => {
	// jsdom media elements can't play — stub the promise-returning methods.
	window.HTMLMediaElement.prototype.play = vi.fn((): Promise<void> => Promise.resolve());
	window.HTMLMediaElement.prototype.pause = vi.fn<() => void>();
	// jsdom has no layout engine — karaoke auto-scroll targets are stubs.
	window.Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ReviewModePage — queue overview", () => {
	it("lists pending items and parks deferred ones below", () => {
		renderPage({ c: null }, [
			item({ id: 10, patientName: "Lívia" }),
			item({ id: 9, patientName: "Ravi", deferredUntil: new Date(Date.now() + 864e5) }),
			item({ id: 8, patientName: "Ana", anamnesisReviewedVersion: 1 }),
		]);
		expect(screen.getByText("Review queue")).toBeTruthy();
		expect(screen.getByText("Lívia")).toBeTruthy();
		expect(screen.getByText("Ravi")).toBeTruthy();
		// Approved rows leave the queue entirely.
		expect(screen.queryByText("Ana")).toBeNull();
		expect(screen.getByText("deferred")).toBeTruthy();
	});

	it("shows the empty-queue summary when nothing is pending", () => {
		renderPage({ c: null }, [item({ anamnesisReviewedVersion: 1 })]);
		expect(screen.getByText("Review queue clear")).toBeTruthy();
	});

	it("queue rows show chief complaint, duration and the pending steps", () => {
		renderPage({}, [item({ chiefComplaint: "dor lombar", audioKey: "k", audioDurationSec: 1452 })]);
		expect(screen.getByText("dor lombar")).toBeTruthy();
		expect(screen.getByText("24:12")).toBeTruthy(); // 1452s
		// Pending-step chips: transcript unstamped + anamnesis unapproved.
		expect(screen.getAllByText("Transcript").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Anamnesis").length).toBeGreaterThan(0);
	});

	it("queue rows flag audio-less and in-flight recordings", () => {
		renderPage({}, [
			item({ id: 10, audioKey: null }),
			item({ id: 11, audioKey: "k", audioStatus: "processing" }),
		]);
		expect(screen.getByText("no audio")).toBeTruthy();
		expect(screen.getByText("processing")).toBeTruthy();
	});

	it("links each item into its review path", () => {
		renderPage({ c: null }, [item({ id: 42 })]);
		expect(screen.getByText("Lívia").closest("a")?.getAttribute("href")).toBe(
			"/portal/doctor/review/42",
		);
	});
});

describe("ReviewModePage — transcript step", () => {
	it("renders the rail, karaoke segments and the uncertainty jump", () => {
		renderPage();
		expect(screen.getAllByText("Review queue").length).toBeGreaterThan(0);
		expect(screen.getByText("Bom dia, como está?")).toBeTruthy();
		// Only seg #1 is below the logprob threshold.
		expect(screen.getByText("Next uncertain")).toBeTruthy();
	});

	it("seek jumps the audio element to the clicked segment", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		fireEvent.click(screen.getByText("Vou examinar agora."));
		expect(audio.currentTime).toBe(5);
		expect(audio.play).toHaveBeenCalled();
	});

	it("next-uncertain seeks the low-confidence segment", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		fireEvent.click(screen.getByText("Next uncertain"));
		expect(audio.currentTime).toBe(2.5);
	});

	it("triage: the playhead reaching an uncertain segment auto-checks it", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		expect(screen.getByText("0 of 1 checked")).toBeTruthy();
		audio.currentTime = 3; // inside seg 1 (2.5–5, the uncertain one)
		fireEvent.timeUpdate(audio);
		expect(screen.getByText("1 of 1 checked")).toBeTruthy();
	});

	it("unverify reopens a checked uncertain chip", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		audio.currentTime = 3;
		fireEvent.timeUpdate(audio);
		expect(screen.getByText("1 of 1 checked")).toBeTruthy();
		fireEvent.click(screen.getByTitle("Mark unchecked"));
		expect(screen.getByText("0 of 1 checked")).toBeTruthy();
	});

	it("high-confidence transcript shows the spot-check banner, no triage", () => {
		const confident = SEGMENTS.map((s) => ({ ...s, avgLogprob: -0.1 }));
		renderPage(
			{},
			[item({})],
			detail({
				transcriptSegments: serializeTranscriptSegments(confident),
			}),
		);
		expect(screen.getByText("High-confidence transcript")).toBeTruthy();
		expect(screen.queryByText("Passages to check")).toBeNull();
	});

	it("saves a segment edit into the Loro log — log gains one entry with seg+text", async () => {
		const save = vi.fn<NonNullable<ConsultationDetailApi["saveTranscriptEdits"]>>(async () => ({
			ok: true,
		}));
		renderPage({ api: api({ saveTranscriptEdits: save }) });
		// Open the inline editor on the uncertain segment.
		fireEvent.click(screen.getAllByTitle("Edit line")[1]!);
		const textarea = screen.getByDisplayValue("Dor de garganta há três dias");
		await userEvent.clear(textarea);
		await userEvent.type(textarea, "Dor abdominal há três dias");
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(save).toHaveBeenCalled());
		const arg = save.mock.calls[0]![0];
		expect(arg.data.id).toBe(10);
		const log = JSON.parse(arg.data.edits) as { seg?: number; text?: string; u: string }[];
		expect(log).toHaveLength(1);
		expect(log[0]!.seg).toBe(1);
		expect(log[0]!.text).toBe("Dor abdominal há três dias");
		// The edited segment displays the corrected text + "edited" tag.
		expect(screen.getByText("Dor abdominal há três dias")).toBeTruthy();
		expect(screen.getByText("edited")).toBeTruthy();
	});

	it("legacy audio (no segments) falls back to reader + full-text edit", async () => {
		const save = vi.fn<NonNullable<ConsultationDetailApi["saveTranscriptEdits"]>>(async () => ({
			ok: true,
		}));
		renderPage(
			{ api: api({ saveTranscriptEdits: save }) },
			[item({})],
			detail({ transcriptSegments: null }),
		);
		expect(screen.getByText("legacy audio")).toBeTruthy();
		fireEvent.click(screen.getByText("Edit transcript"));
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(save).toHaveBeenCalled());
	});

	it("audio-less rows read text only and flag the missing audio", () => {
		renderPage({}, [item({})], detail({ audioKey: null, audioStatus: "none" }));
		expect(screen.getByText("no audio to check against")).toBeTruthy();
		expect(document.querySelector("audio")).toBeNull();
	});

	it("confirm stamps the transcript and advances to the anamnesis step", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		renderPage({ api: api({ reviewTranscript: review }) });
		fireEvent.click(screen.getByText("Confirm transcript & continue"));
		await waitFor(() => expect(review).toHaveBeenCalledWith({ data: 10 }));
		// Sections of step 2 are now on screen.
		await waitFor(() => expect(screen.getByText("Dor de garganta")).toBeTruthy());
	});

	it("transcript-only rows finish the item on confirm — navigates to next", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		renderPage(
			{ api: api({ reviewTranscript: review }) },
			[item({ id: 10, hasAnamnesis: false }), item({ id: 9, patientName: "Ravi" })],
			detail({ anamnesis: null }),
		);
		fireEvent.click(screen.getByText("Confirm transcript & continue"));
		await waitFor(() =>
			expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/portal/doctor/review/9" }),
		);
	});
});

describe("ReviewModePage — anamnesis step", () => {
	it("orders sections low-confidence first and auto-marks evidence on click", () => {
		renderPage({ c: detail({ transcriptReviewedAt: new Date(), transcriptReviewedEdits: 0 }) });
		// baixa-confidence HDA renders ahead of alta-confidence chief complaint.
		const titles = [...document.querySelectorAll("h3")].map((h) => h.textContent);
		expect(titles.indexOf("History of present illness")).toBeLessThan(
			titles.indexOf("Chief complaint"),
		);
		// Clicking a section toggles its evidence on — the transcript pane
		// marks the grounding sentences without a second button.
		let section = screen.getByText("HDA").parentElement;
		while (section && !section.className.includes("cursor-pointer")) {
			section = section.parentElement;
		}
		fireEvent.click(section!);
		expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);
	});

	it("approve stamps and navigates to the next pending item", async () => {
		const approve = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		renderPage(
			{ api: api({ approveAnamnesis: approve }) },
			[item({ id: 10 }), item({ id: 9, patientName: "Ravi" })],
			detail({ transcriptReviewedAt: new Date(), transcriptReviewedEdits: 0 }),
		);
		fireEvent.click(screen.getByText("Approve & next"));
		await waitFor(() => expect(approve).toHaveBeenCalledWith({ data: 10 }));
		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/portal/doctor/review/9" });
	});

	it("no-anamnesis step offers generate, fed with the projected transcript", async () => {
		const gen = vi.fn<NonNullable<ConsultationDetailApi["generateAnamnesis"]>>(async () => ({
			ok: true,
		}));
		renderPage(
			{ api: api({ generateAnamnesis: gen }) },
			[item({})],
			detail({ anamnesis: null, transcriptReviewedAt: new Date(), transcriptReviewedEdits: 0 }),
		);
		fireEvent.click(screen.getByText("Generate anamnesis"));
		await waitFor(() => expect(gen).toHaveBeenCalled());
		const arg = gen.mock.calls[0]![0];
		expect(arg.data.transcript).toContain("Dor de garganta");
	});
});
