// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
	navigate: vi.fn<() => void>(),
	invalidate: vi.fn<() => void>(),
}));
const zkMocks = vi.hoisted(() => ({
	decryptConsultation: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../zk.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../zk.ts")>();
	return { ...orig, decryptConsultation: zkMocks.decryptConsultation };
});
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
import { serializeTranscriptEdits, type TranscriptEditEntry } from "../transcript-edits.ts";
import { bytesToB64, genesisUpdate } from "../transcript-projection.ts";
import type { ConsultationZk } from "../zk.ts";
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
		expect(screen.getByRole("button", { name: "Next uncertain" })).toBeTruthy();
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
		fireEvent.click(screen.getByRole("button", { name: "Next uncertain" }));
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

	it("high-confidence transcript keeps the triage frame with the spot-check note", () => {
		const confident = SEGMENTS.map((s) => ({ ...s, avgLogprob: -0.1 }));
		renderPage(
			{},
			[item({})],
			detail({
				transcriptSegments: serializeTranscriptSegments(confident),
			}),
		);
		// Same card always renders — contents swap chips for the note.
		expect(screen.getByText("Passages to check")).toBeTruthy();
		expect(screen.getByText("High-confidence transcript")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Next uncertain" })).toBeNull();
		expect(screen.queryByText(/of \d+ checked/)).toBeNull();
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

	it("chapter index seeks + plays the audio at the evidence anchor", () => {
		renderPage({ c: detail({ transcriptReviewedAt: new Date(), transcriptReviewedEdits: 0 }) });
		const audio = document.querySelector("audio")!;
		// Both evidence sentences land in the same segment (2.5s).
		const chip = screen.getByText("Chief complaint · 0:02");
		fireEvent.click(chip);
		expect(audio.currentTime).toBe(2.5);
		expect(audio.play).toHaveBeenCalled();
	});

	it("omits chapters whose evidence resolves to no segment", () => {
		renderPage({
			c: detail({
				transcriptReviewedAt: new Date(),
				transcriptReviewedEdits: 0,
				anamnesis: {
					...ANAMNESIS,
					queixa_principal: { ...ANAMNESIS.queixa_principal, evidence: ["paráfrase sem match algum"] },
					hda: { ...ANAMNESIS.hda, evidence: ["outra frase sem match"] },
				},
			}),
		});
		expect(screen.queryByLabelText("Chapters")).toBeNull();
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

describe("ReviewModePage — queue edge cases", () => {
	it("item header and rail fall back to #id when patientName is null", () => {
		renderPage({}, [item({ id: 11, patientName: null })], detail({ patientName: null }));
		expect(screen.getByText("#10")).toBeTruthy();
		expect(screen.getByText("#11")).toBeTruthy();
	});

	it("hides the defer button when the api lacks deferConsultation", () => {
		renderPage({ api: api({ deferConsultation: undefined }) });
		expect(screen.queryByText("Defer review")).toBeNull();
	});

	it("defers an item through the calendar popover and invalidates", async () => {
		const user = userEvent.setup();
		const defer = vi.fn(async () => ({ ok: true }));
		renderPage({ api: api({ deferConsultation: defer }) });
		await user.click(screen.getByText("Defer review"));
		const day = document.querySelector<HTMLButtonElement>(
			'[data-slot="popover-content"] button[data-day]:not([disabled])',
		)!;
		await user.click(day);
		await waitFor(() =>
			expect(defer).toHaveBeenCalledWith({
				data: { id: 10, until: expect.any(String) },
			}),
		);
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
	});

	it("a failed defer keeps the popover open for another pick", async () => {
		const user = userEvent.setup();
		const defer = vi.fn(async () => ({ ok: false }));
		renderPage({ api: api({ deferConsultation: defer }) });
		await user.click(screen.getByText("Defer review"));
		const day = document.querySelector<HTMLButtonElement>(
			'[data-slot="popover-content"] button[data-day]:not([disabled])',
		)!;
		await user.click(day);
		await waitFor(() => expect(defer).toHaveBeenCalledTimes(1));
		// ok:false — the popover stays mounted so the doctor can retry.
		expect(document.querySelector('[data-slot="popover-content"]')).toBeTruthy();
	});

	it("falls back to the default calendar locale for unmapped locales", async () => {
		const user = userEvent.setup();
		const defer = vi.fn(async () => ({ ok: true }));
		renderPage({ api: api({ deferConsultation: defer }), locale: "de" });
		await user.click(screen.getByText("Defer review"));
		expect(document.querySelector('[data-slot="popover-content"]')).toBeTruthy();
	});

	it("item view lists deferred rows dimmed in the rail", () => {
		renderPage(
			{},
			[
				item({ id: 9, patientName: "Ravi", deferredUntil: new Date(Date.now() + 864e5) }),
				item({ id: 10 }),
			],
			detail({}),
		);
		expect(screen.getByText("deferred")).toBeTruthy();
	});

	it("queue rows with nothing pending render no chip row", () => {
		renderPage(
			{},
			[
				item({
					id: 11,
					patientName: null,
					transcriptReviewedAt: new Date(),
					anamnesisVersion: undefined,
					anamnesisReviewedVersion: undefined,
				}),
			],
			detail({}),
		);
		// The crafted row stays pending (unapproved anamnesis) but owes
		// neither step — no Transcript/Anamnesis chips in the rail.
		expect(screen.getByText("#11")).toBeTruthy();
	});

	it("queue overview reports the session tally after the last item", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		const props = {
			queue: [item({ id: 10 })],
			author: "u1",
			api: api({ reviewTranscript: review }),
			portalBase: "/portal/doctor",
		};
		const { rerender } = render(<ReviewModePage {...props} c={detail({ anamnesis: null })} />);
		fireEvent.click(screen.getByText("Confirm transcript & continue"));
		await waitFor(() =>
			expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/portal/doctor/review" }),
		);
		rerender(<ReviewModePage {...props} c={null} />);
		expect(screen.getByText(/1 reviewed this session/)).toBeTruthy();
	});
});

describe("ReviewModePage — transcript step extras", () => {
	const SEG4 = [
		{ start: 0, end: 1, text: "alpha zero", avgLogprob: -0.1 },
		{ start: 1, end: 2, text: "beta one", avgLogprob: -0.9 },
		{ start: 2, end: 3, text: "gamma two", avgLogprob: -0.8 },
		{ start: 3, end: 4, text: "delta three" },
	];
	const seg4Detail = () => detail({ transcriptSegments: serializeTranscriptSegments(SEG4) });

	it("uncertainty chips and timestamp buttons seek the audio", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		// Chip button carries the segment text as its title.
		fireEvent.click(screen.getByTitle("Dor de garganta há três dias"));
		expect(audio.currentTime).toBe(2.5);
		// Timestamp button on the certain segment.
		fireEvent.click(screen.getByTitle("0:05"));
		expect(audio.currentTime).toBe(5);
	});

	it("timeUpdate outside any segment and outside the uncertain set", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		audio.currentTime = 100;
		fireEvent.timeUpdate(audio); // past the last segment — no active row
		audio.currentTime = 0; // inside the certain segment — no auto-check
		fireEvent.timeUpdate(audio);
		expect(screen.getByText("0 of 1 checked")).toBeTruthy();
	});

	it("repeated timeUpdate on a checked segment is a no-op", () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		audio.currentTime = 3;
		fireEvent.timeUpdate(audio);
		fireEvent.timeUpdate(audio);
		expect(screen.getByText("1 of 1 checked")).toBeTruthy();
	});

	it("next-uncertain drains unchecked first, then wraps", () => {
		renderPage({}, [item({})], seg4Detail());
		const audio = document.querySelector("audio")!;
		const next = () => fireEvent.click(screen.getByRole("button", { name: "Next uncertain" }));
		// Nothing checked, playhead at start → first unchecked after it.
		next();
		expect(audio.currentTime).toBe(1);
		audio.currentTime = 1.5;
		fireEvent.timeUpdate(audio); // checks seg 1, active = 1
		audio.currentTime = 3.5;
		fireEvent.timeUpdate(audio); // active = 3; seg 2 still unchecked
		next();
		expect(audio.currentTime).toBe(2); // unchecked anywhere (wraps the active bound)
		audio.currentTime = 2.5;
		fireEvent.timeUpdate(audio); // checks seg 2 — all checked now
		audio.currentTime = 0.5;
		fireEvent.timeUpdate(audio); // active = 0
		next();
		expect(audio.currentTime).toBe(1); // first uncertain past active
		audio.currentTime = 3.5;
		fireEvent.timeUpdate(audio); // active past every uncertain
		next();
		expect(audio.currentTime).toBe(1); // wraps to the first uncertain overall
	});

	it("next-uncertain on a fully confident transcript does nothing", () => {
		const confident = SEGMENTS.map((s) => ({ ...s, avgLogprob: -0.1 }));
		renderPage(
			{},
			[item({})],
			detail({ transcriptSegments: serializeTranscriptSegments(confident) }),
		);
		// No "Next uncertain" button — ArrowRight still reaches the handler.
		const audio = document.querySelector("audio")!;
		audio.currentTime = 30;
		fireEvent.keyDown(window as unknown as Element, { key: "ArrowRight" });
		expect(audio.currentTime).toBe(30);
	});

	it("segment row cancel closes the inline editor", () => {
		renderPage();
		fireEvent.click(screen.getAllByTitle("Edit line")[0]!);
		expect(screen.getByDisplayValue("Bom dia, como está?")).toBeTruthy();
		fireEvent.click(screen.getByText("Cancel"));
		expect(screen.queryByDisplayValue("Bom dia, como está?")).toBeNull();
	});

	it("legacy full-text edit accepts typing then cancels", () => {
		renderPage({}, [item({})], detail({ transcriptSegments: null }));
		fireEvent.click(screen.getByText("Edit transcript"));
		const ta = screen.getByDisplayValue(/Vou examinar agora/);
		fireEvent.change(ta, { target: { value: "texto corrigido" } });
		fireEvent.click(screen.getByText("Cancel"));
		expect(screen.queryByDisplayValue("texto corrigido")).toBeNull();
	});

	it("edit affordances hide when saveTranscriptEdits is absent", () => {
		const { unmount } = renderPage({ api: api({ saveTranscriptEdits: undefined }) });
		expect(screen.queryByTitle("Edit line")).toBeNull();
		unmount();
		renderPage(
			{ api: api({ saveTranscriptEdits: undefined }) },
			[item({})],
			detail({ transcriptSegments: null }),
		);
		expect(screen.queryByText("Edit transcript")).toBeNull();
	});

	it("confirm button hides when reviewTranscript is absent; C is a no-op", () => {
		renderPage({ api: api({ reviewTranscript: undefined }) });
		expect(screen.queryByText("Confirm transcript & continue")).toBeNull();
		fireEvent.keyDown(window as unknown as Element, { key: "c" });
		// Still on the transcript step — segment rows remain.
		expect(screen.getByText("Vou examinar agora.")).toBeTruthy();
	});
});

describe("ReviewModePage — keyboard flow", () => {
	const key = (k: string, target?: Element) =>
		fireEvent.keyDown((target ?? window) as unknown as Element, { key: k });

	it("space toggles playback, arrows seek, C confirms", async () => {
		renderPage();
		const audio = document.querySelector("audio")!;
		key(" ");
		expect(audio.play).toHaveBeenCalled();
		Object.defineProperty(audio, "paused", { value: false, configurable: true });
		key(" ");
		expect(audio.pause).toHaveBeenCalled();
		Object.defineProperty(audio, "paused", { value: true, configurable: true });
		audio.currentTime = 30;
		key("ArrowLeft");
		expect(audio.currentTime).toBe(20);
		key("ArrowRight");
		expect(audio.currentTime).toBe(2.5); // next uncertain segment
		key("c");
		await waitFor(() => expect(screen.getByText("Chief complaint")).toBeTruthy());
	});

	it("uppercase C also confirms; unrelated keys do nothing", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		renderPage({ api: api({ reviewTranscript: review }) });
		key("x");
		expect(review).not.toHaveBeenCalled();
		key("C");
		await waitFor(() => expect(review).toHaveBeenCalledWith({ data: 10 }));
	});

	it("keys typed into the segment editor do not trigger shortcuts", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
		renderPage({ api: api({ reviewTranscript: review }) });
		fireEvent.click(screen.getAllByTitle("Edit line")[0]!);
		const ta = screen.getByDisplayValue("Bom dia, como está?");
		key("c", ta);
		key(" ", ta);
		key("ArrowRight", ta);
		expect(review).not.toHaveBeenCalled();
		const audio = document.querySelector("audio")!;
		expect(audio.currentTime).toBe(0);
	});

	it("shortcuts degrade gracefully without audio", () => {
		renderPage({}, [item({})], detail({ audioKey: null, audioStatus: "none" }));
		key(" ");
		key("ArrowLeft");
		key("ArrowRight");
		key("c");
		// No audio element, no uncertain segments — nothing throws.
		expect(document.querySelector("audio")).toBeNull();
	});
});

describe("ReviewModePage — edit log edge cases", () => {
	let seed = 0;
	const editEntry = (over: Partial<TranscriptEditEntry> = {}): TranscriptEditEntry => ({
		at: "2026-01-01T00:00:00.000Z",
		by: "u1",
		u: bytesToB64(genesisUpdate(`seed-${seed++}`)),
		...over,
	});

	it("stored log entries exercise seg/text metadata branches", async () => {
		const save = vi.fn<NonNullable<ConsultationDetailApi["saveTranscriptEdits"]>>(async () => ({
			ok: true,
		}));
		const stored = serializeTranscriptEdits([
			editEntry(), // no seg/text metadata
			editEntry({ seg: 0 }), // seg without replacement text
			editEntry({ seg: -1, text: "neg" }), // out-of-range segment index
			editEntry({ seg: 99, text: "far" }), // beyond every rendered segment
		]);
		renderPage(
			{ api: api({ saveTranscriptEdits: save }) },
			[item({})],
			detail({
				transcriptSegments: serializeTranscriptSegments(SEGMENTS),
				transcriptEdits: stored,
				transcriptReviewedEdits: 4,
			}),
		);
		// One save produces a fifth log entry and surfaces the
		// "unconfirmed edits" badge (4 stored were already confirmed).
		fireEvent.click(screen.getAllByTitle("Edit line")[0]!);
		const ta = screen.getByDisplayValue("Bom dia, como está?");
		fireEvent.change(ta, { target: { value: "Bom dia, doutor!" } });
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(save).toHaveBeenCalled());
		expect(screen.getByText("1 unconfirmed edits")).toBeTruthy();
	});

	it("a second segment edit offsets into the projected doc", async () => {
		const save = vi.fn<NonNullable<ConsultationDetailApi["saveTranscriptEdits"]>>(async () => ({
			ok: true,
		}));
		const segs = [
			{ start: 0, end: 1, text: "alpha zero", avgLogprob: -0.1 },
			{ start: 1, end: 2, text: "beta one", avgLogprob: -0.9 },
			{ start: 2, end: 3, text: "gamma two", avgLogprob: -0.1 },
		];
		// Segment texts deliberately absent from the transcript → the
		// baseOffsets indexOf fallback path runs.
		renderPage(
			{ api: api({ saveTranscriptEdits: save }), author: null },
			[item({})],
			detail({ transcriptSegments: serializeTranscriptSegments(segs) }),
		);
		let calls = 0;
		const editAndSave = async (idx: number, from: string, to: string) => {
			fireEvent.click(screen.getAllByTitle("Edit line")[idx]!);
			const ta = screen.getByDisplayValue(from);
			fireEvent.change(ta, { target: { value: to } });
			fireEvent.click(screen.getByText("Save"));
			calls += 1;
			await waitFor(() => expect(save).toHaveBeenCalledTimes(calls));
		};
		// Edit seg 1, then seg 2 (projOffset applies the seg-1 delta),
		// then re-edit seg 1 (segEdits hit for oldLen).
		await editAndSave(1, "beta one", "beta corrected");
		await editAndSave(2, "gamma two", "gamma corrected");
		await editAndSave(1, "beta corrected", "beta final");
		const last = JSON.parse(save.mock.calls[2]![0].data.edits) as TranscriptEditEntry[];
		expect(last).toHaveLength(3);
		expect(last[2]!.seg).toBe(1);
		expect(last[2]!.text).toBe("beta final");
		expect(last[2]!.by).toBe("local"); // author null → fallback stamp
	});
});

describe("ReviewModePage — anamnesis step extras", () => {
	const reviewed = () => detail({ transcriptReviewedAt: new Date(), transcriptReviewedEdits: 0 });

	it("step tabs switch between transcript and anamnesis", () => {
		renderPage({}, [item({})], reviewed());
		// Starts on anamnesis — transcript tab brings the segments back.
		expect(screen.getByText("Chief complaint")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Transcript" }));
		expect(screen.getByText("Vou examinar agora.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Anamnesis" }));
		expect(screen.getByText("Chief complaint")).toBeTruthy();
	});

	it("stale approval version keeps the anamnesis step reachable", () => {
		renderPage(
			{},
			[item({})],
			detail({
				...reviewed(),
				anamnesisVersion: 2,
				anamnesisReviewedVersion: 1,
				anamnesisReviewedAt: new Date(),
			}),
		);
		expect(screen.getByText("Chief complaint")).toBeTruthy();
	});

	it("approve not-ok keeps the doctor on the anamnesis step", async () => {
		const approve = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: false }));
		renderPage(
			{ api: api({ approveAnamnesis: approve }) },
			[item({ id: 10 }), item({ id: 9, patientName: "Ravi" })],
			reviewed(),
		);
		fireEvent.click(screen.getByText("Approve & next"));
		await waitFor(() => expect(approve).toHaveBeenCalledWith({ data: 10 }));
		expect(routerMocks.navigate).not.toHaveBeenCalled();
	});

	it("approve button hides when approveAnamnesis is absent", () => {
		renderPage({ api: api({ approveAnamnesis: undefined }) }, [item({})], reviewed());
		expect(screen.queryByText("Approve & next")).toBeNull();
	});

	it("stored edits flag the anamnesis stale and regenerate round-trips", async () => {
		const gen = vi.fn<NonNullable<ConsultationDetailApi["generateAnamnesis"]>>(async () => ({
			ok: true,
		}));
		let seed = 0;
		const stored = serializeTranscriptEdits([
			{
				at: "2026-01-01T00:00:00.000Z",
				by: "u1",
				u: bytesToB64(genesisUpdate(`stale-${seed++}`)),
				seg: 1,
				text: "edited line",
			},
		]);
		renderPage(
			{ api: api({ generateAnamnesis: gen }) },
			[item({})],
			detail({
				...reviewed(),
				transcriptEdits: stored,
				transcriptReviewedEdits: 1,
			}),
		);
		expect(screen.getByText(/Transcript has edits/)).toBeTruthy();
		fireEvent.click(screen.getByText("Regenerate anamnesis"));
		await waitFor(() => expect(gen).toHaveBeenCalled());
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
	});

	it("stale flag shows without a regenerate button when the api lacks generateAnamnesis", () => {
		const stored = serializeTranscriptEdits([
			{
				at: "2026-01-01T00:00:00.000Z",
				by: "u1",
				u: bytesToB64(genesisUpdate("stale-x")),
			},
		]);
		renderPage(
			{ api: api({ generateAnamnesis: undefined }) },
			[item({})],
			detail({ ...reviewed(), transcriptEdits: stored, transcriptReviewedEdits: 0 }),
		);
		expect(screen.getByText(/Transcript has edits/)).toBeTruthy();
		expect(screen.queryByText("Regenerate anamnesis")).toBeNull();
	});

	it("regenerate not-ok does not invalidate", async () => {
		const gen = vi.fn<NonNullable<ConsultationDetailApi["generateAnamnesis"]>>(async () => ({
			ok: false,
		}));
		const stored = serializeTranscriptEdits([
			{
				at: "2026-01-01T00:00:00.000Z",
				by: "u1",
				u: bytesToB64(genesisUpdate("stale-y")),
			},
		]);
		renderPage(
			{ api: api({ generateAnamnesis: gen }) },
			[item({})],
			detail({ ...reviewed(), transcriptEdits: stored, transcriptReviewedEdits: 0 }),
		);
		fireEvent.click(screen.getByText("Regenerate anamnesis"));
		await waitFor(() => expect(gen).toHaveBeenCalled());
		expect(routerMocks.invalidate).not.toHaveBeenCalled();
	});

	it("generate omits patientId when the record is unlinked", async () => {
		const gen = vi.fn<NonNullable<ConsultationDetailApi["generateAnamnesis"]>>(async () => ({
			ok: true,
		}));
		renderPage(
			{ api: api({ generateAnamnesis: gen }) },
			[item({})],
			detail({ ...reviewed(), anamnesis: null, patientId: null }),
		);
		fireEvent.click(screen.getByText("Generate anamnesis"));
		await waitFor(() => expect(gen).toHaveBeenCalled());
		expect(gen.mock.calls[0]![0].data.patientId).toBeUndefined();
	});

	it("generate hides with no api or an empty projected transcript", () => {
		const empty = detail({
			...reviewed(),
			anamnesis: null,
			transcript: "",
			serverTranscript: null,
			correctedTranscript: null,
		});
		const { unmount } = renderPage(
			{ api: api({ generateAnamnesis: undefined }) },
			[item({})],
			empty,
		);
		expect(screen.queryByText("Generate anamnesis")).toBeNull();
		unmount();
		renderPage({ api: api() }, [item({})], empty);
		expect(screen.queryByText("Generate anamnesis")).toBeNull();
	});

	it("pending sections render italic and evidence toggles off", () => {
		const pendingAnamnesis: Anamnesis = {
			...ANAMNESIS,
			conduta: { content: "A preencher pelo médico", confidence: "media", evidence: [] },
		};
		renderPage({}, [item({})], detail({ ...reviewed(), anamnesis: pendingAnamnesis }));
		const pending = screen.getByText("A preencher pelo médico");
		expect(pending.className).toContain("italic");
		// Click a section → evidence marks; click again → cleared.
		const section = (() => {
			let el = screen.getByText("HDA").parentElement;
			while (el && !el.className.includes("cursor-pointer")) el = el.parentElement;
			return el!;
		})();
		fireEvent.click(section);
		expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);
		fireEvent.click(section);
		expect(document.querySelectorAll("mark").length).toBe(0);
	});
});

describe("ReviewModePage — base text pinning", () => {
	const baseCase = (over: Partial<ConsultationDetail>, expected: string) => {
		const { unmount } = renderPage(
			{},
			[item({})],
			detail({ audioKey: null, transcriptSegments: null, ...over }),
		);
		expect(screen.getByText(expected)).toBeTruthy();
		unmount();
	};

	it("projects over the pinned base column with transcript fallback", () => {
		baseCase(
			{
				transcriptEditsBase: "corrected",
				correctedTranscript: "B-CORRECTED",
				serverTranscript: "B-SERVER",
				transcript: "B-TRANSCRIPT",
			},
			"B-CORRECTED",
		);
		baseCase(
			{
				transcriptEditsBase: "corrected",
				correctedTranscript: null,
				serverTranscript: "B-SERVER",
				transcript: "B-TRANSCRIPT",
			},
			"B-SERVER",
		);
		baseCase(
			{
				transcriptEditsBase: "corrected",
				correctedTranscript: null,
				serverTranscript: null,
				transcript: "B-TRANSCRIPT",
			},
			"B-TRANSCRIPT",
		);
		baseCase(
			{
				transcriptEditsBase: "server",
				correctedTranscript: "B-CORRECTED",
				serverTranscript: "B-SERVER",
				transcript: "B-TRANSCRIPT",
			},
			"B-SERVER",
		);
		baseCase(
			{
				transcriptEditsBase: "server",
				correctedTranscript: "B-CORRECTED",
				serverTranscript: null,
				transcript: "B-TRANSCRIPT",
			},
			"B-TRANSCRIPT",
		);
		baseCase(
			{
				transcriptEditsBase: "transcript",
				correctedTranscript: "B-CORRECTED",
				serverTranscript: "B-SERVER",
				transcript: "B-TRANSCRIPT",
			},
			"B-TRANSCRIPT",
		);
		// Unpinned rows default to corrected → server → transcript.
		baseCase({ correctedTranscript: "B-CORRECTED", serverTranscript: "B-SERVER" }, "B-CORRECTED");
		baseCase({ correctedTranscript: null, serverTranscript: "B-SERVER" }, "B-SERVER");
		baseCase(
			{ correctedTranscript: null, serverTranscript: null, transcript: "B-TRANSCRIPT" },
			"B-TRANSCRIPT",
		);
	});
});

describe("ReviewModePage — ZK overlay", () => {
	const zk = { keyring: {}, api: {} } as unknown as ConsultationZk;
	const ciphered = () =>
		detail({
			anamnesisRaw: "v1.aaa",
			anamnesis: null,
			transcriptSegments: "v1.segs",
		});

	it("overlays decrypted fields onto the detail", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "dec transcript",
			serverTranscript: "v1.env",
			correctedTranscript: "dec corrected",
			transcriptSegments: "v1.segs2",
			transcriptEdits: "v1.edits",
			anamnesis: JSON.stringify(ANAMNESIS),
		});
		renderPage({ zk }, [item({})], ciphered());
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
		// Envelope fields collapse to null → non-rich legacy reader shows
		// the decrypted corrected transcript as the projected base.
		expect(await screen.findByText("dec corrected")).toBeTruthy();
		const row = zkMocks.decryptConsultation.mock.calls[0]![2] as { anamnesis?: unknown };
		expect(row.anamnesis).toBe("v1.aaa"); // anamnesisRaw ?? null
	});

	it("null decrypt result keeps the stored row", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce(null);
		renderPage({ zk }, [item({})], ciphered());
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
		expect(await screen.findByText(/Vou examinar agora/)).toBeTruthy();
	});

	it("non-string transcript and corrupt anamnesis fall back to stored values", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: 42,
			serverTranscript: null,
			correctedTranscript: null,
			transcriptSegments: null,
			transcriptEdits: null,
			anamnesis: "not json{",
		});
		renderPage({ zk }, [item({})], ciphered());
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
		expect(await screen.findByText(/Vou examinar agora/)).toBeTruthy();
	});

	it("decrypt rejection leaves the row untouched", async () => {
		zkMocks.decryptConsultation.mockRejectedValueOnce(new Error("locked"));
		renderPage({ zk }, [item({})], ciphered());
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
		expect(await screen.findByText(/Vou examinar agora/)).toBeTruthy();
	});

	it("a decrypt resolving after unmount is ignored", async () => {
		let resolve!: (v: unknown) => void;
		zkMocks.decryptConsultation.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const { unmount } = renderPage({ zk }, [item({})], ciphered());
		unmount();
		resolve({ transcript: "late" });
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
	});
});

describe("ReviewModePage — failure paths", () => {
	it("a failed save keeps the editor open and marks nothing", async () => {
		const save = vi.fn<NonNullable<ConsultationDetailApi["saveTranscriptEdits"]>>(async () => ({
			ok: false,
		}));
		renderPage({ api: api({ saveTranscriptEdits: save }) });
		fireEvent.click(screen.getAllByTitle("Edit line")[0]!);
		const ta = screen.getByDisplayValue("Bom dia, como está?");
		fireEvent.change(ta, { target: { value: "texto novo" } });
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(save).toHaveBeenCalled());
		// res.ok false → editing stays, no "edited" tag.
		expect(screen.getByDisplayValue("texto novo")).toBeTruthy();
		expect(screen.queryByText("edited")).toBeNull();
	});

	it("a failed confirm keeps the doctor on the transcript step", async () => {
		const review = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: false }));
		renderPage({ api: api({ reviewTranscript: review }) });
		fireEvent.click(screen.getByText("Confirm transcript & continue"));
		await waitFor(() => expect(review).toHaveBeenCalledWith({ data: 10 }));
		expect(screen.queryByText("Chief complaint")).toBeNull();
		expect(screen.getByText("Vou examinar agora.")).toBeTruthy();
	});

	it("a rejected play() on seek is swallowed", async () => {
		window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(new Error("nope")));
		renderPage();
		const audio = document.querySelector("audio")!;
		fireEvent.click(screen.getByText("Vou examinar agora."));
		expect(audio.currentTime).toBe(5);
		await waitFor(() => expect(audio.play).toHaveBeenCalled());
	});

	it("a rejected play() on space-toggle is swallowed", async () => {
		window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(new Error("nope")));
		renderPage();
		fireEvent.keyDown(window as unknown as Element, { key: " " });
		const audio = document.querySelector("audio")!;
		await waitFor(() => expect(audio.play).toHaveBeenCalled());
	});
});

describe("ReviewModePage — ZK overlay without raw anamnesis", () => {
	it("passes null anamnesis to the decrypt call when anamnesisRaw is absent", async () => {
		const zk = { keyring: {}, api: {} } as unknown as ConsultationZk;
		zkMocks.decryptConsultation.mockResolvedValueOnce(null);
		renderPage({ zk }, [item({})], detail({}));
		await waitFor(() => expect(zkMocks.decryptConsultation).toHaveBeenCalled());
		const row = zkMocks.decryptConsultation.mock.calls[0]![2] as { anamnesis?: unknown };
		expect(row.anamnesis).toBeNull();
	});
});
