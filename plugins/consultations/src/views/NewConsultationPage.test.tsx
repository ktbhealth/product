// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { Anamnesis } from "@ktb/anamnesis";
import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";
import type {
	SessionStats,
	Transcriber,
	TranscriptionBackend,
	TranscriptionEngineMessage,
	TranscriptionStatus,
	TranscriptEvent,
} from "@ktb/transcription";
import type { NewConsultationApi } from "./NewConsultationPage.tsx";
import type { ConsultationZk } from "../zk.ts";

// jsdom lacks ResizeObserver + Web Animations — Base UI internals
// (ScrollArea) call them during mount/effects.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
Element.prototype.getAnimations ??= () => [];

// ---------- controllable transcriber mocks ----------
let micSupported = true;
let micCb: ((ev: TranscriptEvent) => void) | null = null;
let tabCb: ((ev: TranscriptEvent) => void) | null = null;
let statusImpl: () => TranscriptionStatus = () => ({
	state: "idle",
	device: null,
});
const micStop = vi.fn();
const tabStop = vi.fn();
const engineSubs = new Set<(m: TranscriptionEngineMessage) => void>();
// Optional fallback hooks — null means the transcriber lacks the method.
let micStatsFn: (() => SessionStats) | null = null;
let micRecFn: (() => Promise<Blob | null>) | null = null;
let tabStatsFn: (() => SessionStats) | null = null;
let tabRecFn: (() => Promise<Blob | null>) | null = null;
const backendLoad = vi.fn();

const backend: TranscriptionBackend = {
	mic: (): Transcriber => ({
		get supported() {
			return micSupported;
		},
		start: (cb: (ev: TranscriptEvent) => void) => {
			micCb = cb;
		},
		stop: micStop,
		...(micStatsFn ? { sessionStats: micStatsFn } : {}),
		...(micRecFn ? { recording: micRecFn } : {}),
	}),
	tab: (): Transcriber => ({
		supported: true,
		start: (cb: (ev: TranscriptEvent) => void) => {
			tabCb = cb;
		},
		stop: tabStop,
		...(tabStatsFn ? { sessionStats: tabStatsFn } : {}),
		...(tabRecFn ? { recording: tabRecFn } : {}),
	}),
	status: () => statusImpl(),
	subscribe: (fn: (m: TranscriptionEngineMessage) => void) => {
		engineSubs.add(fn);
		return () => engineSubs.delete(fn);
	},
	load: backendLoad,
};

const navigateMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: (props: Record<string, unknown>) =>
			React.createElement(
				"a",
				{ href: typeof props.to === "string" ? props.to : "#", ...props },
				props.children as never,
			),
		useNavigate: () => navigateMock,
	};
});
const zkMocks = vi.hoisted(() => ({
	newConsultationDek: vi.fn(async () => ({
		dek: { tag: "dek" } as never,
		grants: [{ readerKind: "device" as const, readerPubkey: "w", wrappedDek: "w1.g" }],
	})),
	consultationDek: vi.fn(async (): Promise<unknown> => ({ tag: "dek" })),
	encryptConsultationDraft: vi.fn(async () => ({
		transcript: "v1.t.e",
		anamnesis: "v1.a.e",
	})),
	encryptAnamnesis: vi.fn(async () => "v1.a2.e"),
	signAnamnesis: vi.fn(async () => ({ contentHash: "h1", signature: "s1" })),
	extractAnamnesisZk: vi.fn(),
	originals: {} as Record<string, unknown>,
}));
vi.mock("../zk.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../zk.ts")>();
	zkMocks.originals.extractAnamnesisZk = orig.extractAnamnesisZk;
	return { ...orig, ...zkMocks };
});

const streamMocks = vi.hoisted(() => ({
	encryptToBlob: vi.fn(async () => new Uint8Array([9])),
}));
vi.mock("@ktb/crypto/stream", () => streamMocks);

const draftMock = vi.hoisted(() => {
	const state: { draft: Record<string, unknown> | null } = { draft: null };
	const store = {
		load: vi.fn(async () => state.draft),
		save: vi.fn(async (d: Record<string, unknown>) => {
			state.draft = d;
		}),
		clear: vi.fn(async () => {
			state.draft = null;
		}),
	};
	return { state, store };
});
vi.mock("../recording-draft.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../recording-draft.ts")>();
	return { ...orig, defaultDraftStore: () => draftMock.store };
});

// jsdom has no layout — every rect is 0,0 so the lib's document-level
// pointerdown hit-test thinks every click lands on the separator
// (preventDefault + steals focus). The split behavior is the lib's
// contract, not this page's — render children inline instead.
vi.mock("@ktbhealth/ui/components/resizable", () => ({
	ResizablePanelGroup: ({ children, className }: { children?: ReactNode; className?: string }) => (
		<div data-slot="resizable-panel-group" className={className}>
			{children}
		</div>
	),
	ResizablePanel: ({ children }: { children?: ReactNode }) => (
		<div data-slot="resizable-panel">{children}</div>
	),
	ResizableHandle: () => <div data-slot="resizable-handle" role="separator" />,
}));

import { NewConsultationPage } from "./NewConsultationPage.tsx";
import { liveConsultationTurns } from "./-live-turns.ts";

const SECTION = { content: "", confidence: "baixa" as const, evidence: [] as string[] };
const ANAMNESIS: Anamnesis = {
	queixa_principal: { content: "Dor de cabeça", confidence: "alta", evidence: ["dor de cabeça"] },
	hda: SECTION,
	antecedentes: SECTION,
	alergias: SECTION,
	medicamentos_em_uso: SECTION,
	exame_fisico: SECTION,
	hipoteses: SECTION,
	conduta: SECTION,
};

function makeApi(overrides: Partial<NewConsultationApi> = {}): NewConsultationApi {
	return {
		getLiveConsultation: vi.fn(async () => null),
		extractAnamnesis: vi.fn(async () => ({ anamnesis: ANAMNESIS, engine: "heuristic" })),
		attachAnamnesis: vi.fn(async () => ({ ok: true })),
		saveConsultation: vi.fn(async () => ({ id: 42 })),
		recordConsent: vi.fn(async () => ({ ok: true })),
		createPatient: vi.fn(async () => ({ ok: true as const, patient: { id: 7, name: "Ana" } })),
		...overrides,
	} as NewConsultationApi;
}

const PATIENTS = [
	{ id: 1, name: "Maria" },
	{ id: 2, name: "João" },
];

function renderPage(
	api = makeApi(),
	patients = PATIENTS,
	initialPatientId?: number,
	zk?: ConsultationZk,
	portalBase?: string,
	liveFlow = false,
	physician?: string,
	user?: { name?: string | null; email: string } | null,
) {
	return render(
		<NewConsultationPage
			initialPatients={patients}
			initialPatientId={initialPatientId}
			api={api}
			backend={backend}
			zk={zk}
			portalBase={portalBase}
			liveFlow={liveFlow}
			physician={physician}
			user={user}
		/>,
	);
}

async function consent(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByText(/I declare that the patient/));
}

async function fillTranscript(text = "paciente relata dor") {
	fireEvent.change(screen.getByLabelText("Consultation text"), { target: { value: text } });
}

async function choosePatient(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.click(screen.getByLabelText("Patient"));
	await user.click(await screen.findByRole("option", { name }));
}

async function generateAnamnesis(user: ReturnType<typeof userEvent.setup>) {
	await fillTranscript();
	await user.click(screen.getByText("Generate anamnesis →"));
	await screen.findByText("high confidence");
}

// Shared per-test reset — top-level describes outside "NewConsultationPage"
// must opt into these hooks explicitly (RTL cleanup is not automatic here).
function resetPageTestDoubles() {
	micSupported = true;
	micCb = null;
	tabCb = null;
	micStatsFn = null;
	micRecFn = null;
	tabStatsFn = null;
	tabRecFn = null;
	statusImpl = () => ({ state: "idle", device: null });
	engineSubs.clear();
	draftMock.state.draft = null;
	draftMock.store.load.mockClear();
	draftMock.store.save.mockClear();
	draftMock.store.clear.mockClear();
	backendLoad.mockClear();
	navigateMock.mockClear();
	vi.stubGlobal("fetch", vi.fn());
	// jsdom lacks dialog.showModal
	HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
		this.setAttribute("open", "");
	});
	HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
		this.removeAttribute("open");
	});
	// Base UI's scroll lock is a module-level singleton whose lock/unlock
	// is deferred through setTimeout(0) — a modal unmounted at test end can
	// leak `overflow: hidden`/`scrollbar-gutter` onto <body>/<html> and
	// poison later tests. Reset the inline styles it manages.
	document.body.removeAttribute("style");
	document.documentElement.removeAttribute("style");
	document.documentElement.removeAttribute("data-base-ui-scroll-locked");
}

function teardownPageTest() {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
}

describe("NewConsultationPage", () => {
	beforeEach(resetPageTestDoubles);
	afterEach(teardownPageTest);

	it("renders empty state", async () => {
		const user = userEvent.setup();
		renderPage();
		expect(screen.getByText("New consultation")).toBeTruthy();
		// The anamnesis surface lives in the drawer now.
		await user.click(screen.getByText("AI anamnesis"));
		await screen.findByText(/structured anamnesis appears here/);
	});

	it("creates a new patient from name + age and offers to complete the record", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await user.type(screen.getByLabelText("New patient name"), "Ana");
		await user.type(screen.getByLabelText("New patient age"), "40");
		await user.click(screen.getByText("+ patient"));
		await waitFor(() =>
			expect(api["createPatient"]).toHaveBeenCalledWith({
				data: { name: "Ana", birthDate: String(new Date().getFullYear() - 40) },
			}),
		);
		await waitFor(() => expect(screen.getByLabelText("Patient").textContent).toContain("Ana"));
		expect(screen.getByText("Complete the record").getAttribute("href")).toBe("/patients/7/edit");
		expect((screen.getByLabelText("New patient age") as HTMLInputElement).value).toBe("");
		// switching to another patient hides the shortcut
		await choosePatient(user, "Maria");
		expect(screen.queryByText("Complete the record")).toBeNull();
	});

	it("prefixes the complete-record link with portalBase", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api, PATIENTS, undefined, undefined, "/portal");
		await user.type(screen.getByLabelText("New patient name"), "Ana");
		await user.type(screen.getByLabelText("New patient age"), "40");
		await user.click(screen.getByText("+ patient"));
		await waitFor(() =>
			expect(screen.getByText("Complete the record").getAttribute("href")).toBe(
				"/portal/patients/7/edit",
			),
		);
	});

	it("requires an age for quick registration", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await user.type(screen.getByLabelText("New patient name"), "Ana");
		await user.click(screen.getByText("+ patient"));
		expect(screen.getByText("Enter the patient's age.").getAttribute("role")).toBe("alert");
		await user.type(screen.getByLabelText("New patient age"), "4.5");
		await user.click(screen.getByText("+ patient"));
		expect(api["createPatient"]).not.toHaveBeenCalled();
	});

	it("preselects the patient passed by the record page", () => {
		renderPage(makeApi(), PATIENTS, 2);
		expect(screen.getByLabelText("Patient").textContent).toContain("João");
	});

	it("ignores an unknown preselected patient", () => {
		renderPage(makeApi(), PATIENTS, 99);
		expect(screen.getByLabelText("Patient").textContent).toContain("unlinked");
	});

	it("ignores empty patient name", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await user.click(screen.getByText("+ patient"));
		expect(api["createPatient"]).not.toHaveBeenCalled();
	});

	it("shows the server's validation error for quick registration", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			createPatient: vi.fn(async () => ({
				ok: false as const,
				errors: { birthDate: "invalid_date" as const },
			})),
		});
		renderPage(api);
		await user.type(screen.getByLabelText("New patient name"), "X");
		await user.type(screen.getByLabelText("New patient age"), "200");
		await user.click(screen.getByText("+ patient"));
		expect(await screen.findByText("Enter a valid date.")).toBeTruthy();
	});

	it("falls back to a generic error when the server gives no field error", async () => {
		const user = userEvent.setup();
		const api = makeApi({ createPatient: vi.fn(async () => ({ ok: false as const, errors: {} })) });
		renderPage(api);
		await user.type(screen.getByLabelText("New patient name"), "X");
		await user.type(screen.getByLabelText("New patient age"), "30");
		await user.click(screen.getByText("+ patient"));
		expect(await screen.findByText("Could not register the patient.")).toBeTruthy();
	});

	it("selects an existing patient and toggles consent", async () => {
		const user = userEvent.setup();
		renderPage();
		await choosePatient(user, "João");
		expect(screen.getByLabelText("Patient").textContent).toContain("João");
		await consent(user);
		const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(cb.checked).toBe(true);
		await user.click(screen.getByText(/I declare that the patient/));
		expect(cb.checked).toBe(false);
	});

	it("switches source tabs", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Upload"));
		expect(screen.getByText("Upload recording")).toBeTruthy();
		await user.click(screen.getByText("Teleconsult (bot)"));
		expect(screen.getByLabelText("Teleconsult link")).toBeTruthy();
		await user.click(screen.getByText("Record"));
		expect(screen.getByText("Record microphone")).toBeTruthy();
	});

	it("shows consent warning and disables recording until consent", async () => {
		const user = userEvent.setup();
		renderPage();
		expect(screen.getByText(/Check the consent box above/)).toBeTruthy();
		const btn = screen.getByText("Record microphone").closest("button")!;
		expect(btn.disabled).toBe(true);
		await consent(user);
		expect(btn.disabled).toBe(false);
	});

	it("shows unsupported message when whisper unsupported", () => {
		micSupported = false;
		renderPage();
		expect(screen.getByText(/Recording is not supported/)).toBeTruthy();
	});

	it("mic recording lifecycle: start, partial, final, stop", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		expect(micCb).not.toBeNull();
		expect(screen.getByText("Stop microphone")).toBeTruthy();
		expect(screen.getByText(/recording… speak normally/)).toBeTruthy();

		act(() => micCb!({ type: "partial", text: "acha que" }));
		await screen.findByText(/acha que…/);
		act(() => micCb!({ type: "final", text: "tem febre" }));
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toContain(
				"Doctor: tem febre",
			),
		);

		await user.click(screen.getByText("Stop microphone"));
		expect(micStop).toHaveBeenCalled();
		expect(screen.getByText("Record microphone")).toBeTruthy();
	});

	it("mic error event sets error and stops recording", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		act(() => micCb!({ type: "error", message: "mic denied" }));
		await screen.findByText("mic denied");
		expect(screen.getByText("Record microphone")).toBeTruthy();
	});

	it("mic end event stops recording", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		act(() => micCb!({ type: "end" }));
		expect(screen.getByText("Record microphone")).toBeTruthy();
	});

	it("tab capture lifecycle appends Patient lines", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		expect(tabCb).not.toBeNull();
		act(() => tabCb!({ type: "final", text: "oi doutor" }));
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toContain(
				"Patient: oi doutor",
			),
		);
		await user.click(screen.getByText("Stop tab"));
		expect(tabStop).toHaveBeenCalled();
	});

	it("tab error event sets error", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		act(() => tabCb!({ type: "error", message: "no tab" }));
		await screen.findByText("no tab");
		expect(screen.getByText("Capture call tab")).toBeTruthy();
	});

	it("tab end event stops capture", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		act(() => tabCb!({ type: "end" }));
		expect(screen.getByText("Capture call tab")).toBeTruthy();
	});

	it("uploads audio file and appends transcript", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ text: "transcrito" }),
			})),
		);
		renderPage();
		await user.click(screen.getByText("Upload"));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["audio"], "a.webm", { type: "audio/webm" });
		fireEvent.change(input, { target: { files: [file] } });
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
				"transcrito",
			),
		);
	});

	it("upload appends to existing transcript and handles errors", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		renderPage();
		await fillTranscript("existente");
		await user.click(screen.getByText("Upload"));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["x"], "a.mp3")] } });
		await screen.findByText(/transcription failed \(500\)/);
	});

	it("upload with no file does nothing", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Upload"));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [] } });
	});

	it("sends bot and polls live consultation", async () => {
		const user = userEvent.setup();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const api = makeApi({
			getLiveConsultation: vi
				.fn()
				.mockResolvedValueOnce({ transcript: "Doctor: oi", status: "live" })
				.mockResolvedValue({ transcript: "Doctor: oi\nPaciente: olá", status: "done" }),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 9, provider: "stub" }),
			})),
		);
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "https://meet.google.com/abc");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/consultation #9/);
		await vi.advanceTimersByTimeAsync(1600);
		await vi.advanceTimersByTimeAsync(1600);
		vi.useRealTimers();
		expect(api["getLiveConsultation"]).toHaveBeenCalled();
	});

	it("sendBot guards empty url and handles failure", async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn(async () => ({
			ok: false,
			status: 400,
			json: async () => ({ error: "bad url" }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		renderPage();
		await user.click(screen.getByText("Teleconsult (bot)"));
		const btn = screen.getByText("Send bot").closest("button")!;
		expect(btn.disabled).toBe(true);
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText("bad url");
	});

	it("sendBot handles missing consultationId in response", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
		);
		renderPage();
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/bot failed: HTTP 200/);
	});

	it("generates anamnesis", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await generateAnamnesis(user);
		expect(api["extractAnamnesis"]).toHaveBeenCalled();
		expect(screen.getByText("engine: heuristic")).toBeTruthy();
	});

	it("passes the selected patientId to extraction", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await choosePatient(user, "João");
		await generateAnamnesis(user);
		expect(api["extractAnamnesis"]).toHaveBeenCalledWith({
			data: { transcript: "paciente relata dor", patientId: 2 },
		});
	});

	it("renders the historico block when the anamnesis carries one", async () => {
		const user = userEvent.setup();
		const withHistory: Anamnesis = {
			...ANAMNESIS,
			historico: {
				content: 'Consultas anteriores (1):\n- 05/03/2026 (#8): queixa "Febre"',
				confidence: "alta",
				evidence: ["consulta #8"],
			},
		};
		const api = makeApi({
			extractAnamnesis: vi.fn(async () => ({ anamnesis: withHistory, engine: "heuristic" })),
		});
		renderPage(api);
		await generateAnamnesis(user);
		expect(screen.getByText("Prior consultations")).toBeTruthy();
		expect(screen.getByText(/Consultas anteriores \(1\)/)).toBeTruthy();
	});

	it("generate guards empty transcript and surfaces errors", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			extractAnamnesis: vi.fn(async () => {
				throw new Error("llm down");
			}),
		});
		renderPage(api);
		const btn = screen.getByText("Generate anamnesis →").closest("button")!;
		expect(btn.disabled).toBe(true);
		await fillTranscript("algo");
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("llm down");
	});

	it("edits a section textarea", async () => {
		const user = userEvent.setup();
		renderPage();
		await generateAnamnesis(user);
		const ta = document.getElementById("sec-queixa_principal") as HTMLTextAreaElement;
		fireEvent.change(ta, { target: { value: "editado" } });
		expect(ta.value).toBe("editado");
	});

	it("shows evidence details when present", async () => {
		const user = userEvent.setup();
		renderPage();
		await generateAnamnesis(user);
		expect(screen.getByText(/evidence \(1\)/)).toBeTruthy();
	});

	it("copies anamnesis to clipboard", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderPage();
		await generateAnamnesis(user);
		await user.click(screen.getByText("Copy"));
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		await screen.findByText(/Anamnesis copied/);
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText(/Anamnesis copied/)).toBeNull());
	});

	it("copy failure sets error", async () => {
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
			configurable: true,
		});
		renderPage();
		await generateAnamnesis(user);
		await user.click(screen.getByText("Copy"));
		await screen.findByText(/Could not copy/);
	});

	it("saves a new consultation with consent", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await consent(user);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		expect(api["saveConsultation"]).toHaveBeenCalled();
		expect(api["recordConsent"]).toHaveBeenCalledWith({ data: 42 });
		// dialog actions
		expect(screen.getByText("Download PDF")).toBeTruthy();
		expect(screen.getByText("View consultation")).toBeTruthy();
		await user.click(screen.getByText("Confirm"));
		// now shows update label
		await user.click(screen.getByText("Update consultation"));
		await screen.findByText("Consultation updated");
		expect(api["attachAnamnesis"]).toHaveBeenCalled();
	});

	it("save without consent skips recordConsent", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api, []);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		expect(api["recordConsent"]).not.toHaveBeenCalled();
	});

	it("save error paths: attach fails, save fails, exception", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			attachAnamnesis: vi.fn(async () => ({ ok: false })),
			saveConsultation: vi.fn(async () => {
				throw new Error("db gone");
			}),
		});
		renderPage(api);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("db gone");
		await user.click(screen.getByText("Got it"));
	});

	it("save with liveId uses attachAnamnesis path", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			attachAnamnesis: vi.fn(async () => ({ ok: true })),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 5, provider: "stub" }),
			})),
		);
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/consultation #5/);
		await fillTranscript("transcrição da call");
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("high confidence");
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Consultation updated");
		expect(api["attachAnamnesis"]).toHaveBeenCalled();
		expect(api["saveConsultation"]).not.toHaveBeenCalled();
	});

	it("resuming an agenda shell fills it with this browser's transcript (T-257)", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<NewConsultationPage
				initialPatients={PATIENTS}
				initialPatientId={1}
				resumeConsultationId={42}
				api={api}
				backend={backend}
				liveFlow={false}
			/>,
		);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Consultation updated");
		expect(api["saveConsultation"]).not.toHaveBeenCalled();
		expect(api["attachAnamnesis"]).toHaveBeenCalledWith({
			data: expect.objectContaining({
				consultationId: 42,
				patientId: 1,
				transcript: "paciente relata dor",
			}),
		});
	});

	it("updated save dialog shows consent note", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			attachAnamnesis: vi.fn(async () => ({ ok: true })),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 5, provider: "stub" }),
			})),
		);
		renderPage(api);
		await consent(user);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/consultation #5/);
		await fillTranscript("transcrição da call");
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("high confidence");
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Consultation updated");
		expect(document.body.textContent).toContain("Patient consent recorded");
		expect(document.body.textContent).not.toContain("second opinion");
	});

	it("save dialog never mentions second opinion", async () => {
		const user = userEvent.setup();
		renderPage();
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		const dialog = await screen.findByText("Anamnesis saved successfully");
		expect(dialog.textContent).not.toContain("second opinion");
		expect(dialog.textContent).not.toContain("Patient consent");
	});

	it("saveDialog error variant for non-Error throw", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			saveConsultation: vi.fn(async () => {
				throw "string error";
			}),
		});
		renderPage(api);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Could not save");
		expect(screen.getByText("string error")).toBeTruthy();
	});

	it("dialog closes via backdrop click", async () => {
		const user = userEvent.setup();
		renderPage();
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		const dialog = document.querySelector("dialog") as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		// click directly on the dialog element = backdrop
		fireEvent.click(dialog);
		await waitFor(() => expect(dialog.open).toBe(false));
	});

	it("sample transcript and clear buttons", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Use sample"));
		const ta = screen.getByLabelText("Consultation text") as HTMLTextAreaElement;
		expect(ta.value.length).toBeGreaterThan(50);
		await user.click(screen.getByText("Clear"));
		expect(ta.value).toBe("");
	});

	it("textarea onChange updates transcript", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.type(screen.getByLabelText("Consultation text"), "digitado");
		expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
			"digitado",
		);
	});

	it("engine label renders", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			extractAnamnesis: vi.fn(async () => ({ anamnesis: ANAMNESIS, engine: "openai:gpt" })),
		});
		renderPage(api);
		await generateAnamnesis(user);
		expect(screen.getByText("engine: openai:gpt")).toBeTruthy();
	});

	it("model status updates from engine messages", async () => {
		renderPage();
		for (const fn of engineSubs) fn({ type: "progress", message: "baixando 50%" });
		await screen.findByText(/baixando 50%/);
		for (const fn of engineSubs) fn({ type: "ready", device: "webgpu" });
		await screen.findByText(/model ready \(webgpu\)/);
		for (const fn of engineSubs) fn({ type: "error", message: "falhou tudo" });
		await screen.findByText(/model unavailable: falhou tudo/);
	});

	it("engine error with a segment id is ignored; messageless errors still surface", async () => {
		renderPage();
		// Segment-scoped errors (id present) must not clobber model status.
		for (const fn of engineSubs) fn({ type: "error", id: "seg-1", message: "chunk failed" });
		// A global error without a message falls back to the empty suffix.
		for (const fn of engineSubs) fn({ type: "error" });
		await screen.findByText(/model unavailable/);
	});

	it("live consultation done stops polling and shows call ended", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			getLiveConsultation: vi.fn(async () => ({ transcript: "t", status: "done" })),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 3, provider: "stub" }),
			})),
		);
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/call ended/, {}, { timeout: 4000 });
	});

	it("shows ready model status on mount when engine already loaded", () => {
		statusImpl = () => ({ state: "ready", device: "webgpu" });
		renderPage();
		expect(screen.getByText(/model ready \(webgpu\)/)).toBeTruthy();
	});

	it("progress engine message without text clears status", async () => {
		renderPage();
		for (const fn of engineSubs) fn({ type: "progress" });
		for (const fn of engineSubs) fn({ type: "progress", message: "quase" });
		await screen.findByText(/quase/);
	});

	it("poll skips null live consultation responses", async () => {
		const user = userEvent.setup();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const api = makeApi({
			getLiveConsultation: vi.fn(async () => null),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 4, provider: "stub" }),
			})),
		);
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/consultation #4/);
		await vi.advanceTimersByTimeAsync(3200);
		expect(api["getLiveConsultation"]).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("appends upload transcript to existing text", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ text: "via upload" }),
			})),
		);
		renderPage();
		await fillTranscript("existente");
		await user.click(screen.getByText("Upload"));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["x"], "a.webm")] } });
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
				"existente\nvia upload",
			),
		);
	});

	it("upload reports generic error for non-Error json failure", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => {
					throw "bad-json";
				},
			})),
		);
		renderPage();
		await user.click(screen.getByText("Upload"));
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["x"], "a.webm")] } });
		await screen.findByText("transcription failed");
	});

	it("mic final events join with newlines", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		act(() => micCb!({ type: "final", text: "primeira" }));
		act(() => micCb!({ type: "final", text: "segunda" }));
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
				"Doctor: primeira\nDoctor: segunda",
			),
		);
	});

	it("tab partial and consecutive finals", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		act(() => tabCb!({ type: "partial", text: "parcial aba" }));
		await screen.findByText(/parcial aba/);
		act(() => tabCb!({ type: "final", text: "um" }));
		act(() => tabCb!({ type: "final", text: "dois" }));
		await waitFor(() =>
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
				"Patient: um\nPatient: dois",
			),
		);
	});

	it("generate surfaces non-Error extractor failures", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			extractAnamnesis: vi.fn(async () => {
				throw "extractor-string";
			}),
		});
		renderPage(api);
		await fillTranscript("algo");
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("extractor-string");
	});

	it("save sends engine unknown and attach failure shows session error", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ consultationId: 8, provider: "stub" }),
			})),
		);
		const api = makeApi({
			extractAnamnesis: vi.fn(async () => ({ anamnesis: ANAMNESIS, engine: undefined as never })),
			attachAnamnesis: vi.fn(async () => ({ ok: false })),
		});
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		await user.type(screen.getByLabelText("Teleconsult link"), "http://x");
		await user.click(screen.getByText("Send bot"));
		await screen.findByText(/consultation #8/);
		await fillTranscript("transcrição");
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("high confidence");
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText(/session expired/);
		expect(api["attachAnamnesis"]).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ engine: "unknown" }),
			}),
		);
	});

	it("save without id in response throws", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			saveConsultation: vi.fn(async () => ({})) as never,
			extractAnamnesis: vi.fn(async () => ({ anamnesis: ANAMNESIS, engine: undefined as never })),
		});
		renderPage(api);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText(/could not save/);
		expect(api["saveConsultation"]).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ engine: "unknown" }),
			}),
		);
	});

	it("clearing patient select sets patientId null", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		renderPage(api);
		await choosePatient(user, "Maria");
		await choosePatient(user, "unlinked");
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		expect(api["saveConsultation"]).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ patientId: undefined }) }),
		);
	});

	it("sendBot and generate guards reject empty input via disabled-button clicks", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		renderPage(api);
		await user.click(screen.getByText("Teleconsult (bot)"));
		// disabled button still dispatches click in jsdom → inner guard must hold
		fireEvent.click(screen.getByText("Send bot"));
		expect(fetchMock).not.toHaveBeenCalled();
		await user.click(screen.getByText("Record"));
		fireEvent.change(screen.getByLabelText("Consultation text"), { target: { value: "   " } });
		fireEvent.click(screen.getByText("Generate anamnesis →"));
		expect(api["extractAnamnesis"]).not.toHaveBeenCalled();
	});

	it("save dialog names the selected patient", async () => {
		const user = userEvent.setup();
		renderPage();
		await choosePatient(user, "Maria");
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		const dialog = document.querySelector("dialog") as HTMLDialogElement;
		expect(dialog.textContent).toContain("for Maria");
	});

	describe("draft persistence (T-222)", () => {
		const DRAFT = {
			audio: new Blob(["audio"], { type: "audio/webm" }),
			transcript: "Doctor: rascunho recuperado",
			patientId: 2,
			savedAt: Date.now(),
		};

		beforeEach(() => {
			// jsdom lacks blob URLs — the player just needs a src string.
			URL.createObjectURL = vi.fn(() => "blob:draft-audio");
			URL.revokeObjectURL = vi.fn();
		});

		it("recovered draft banner restores transcript + patient and hides", async () => {
			draftMock.state.draft = DRAFT;
			const user = userEvent.setup();
			renderPage();
			await screen.findByText(/Draft recovered — recording finished at/);
			// the blob previews right in the banner
			await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(DRAFT.audio));
			expect(document.querySelector('audio[src="blob:draft-audio"]')).not.toBeNull();
			await user.click(screen.getByText("Restore draft"));
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toContain(
				"rascunho recuperado",
			);
			expect(screen.queryByText(/Draft recovered/)).toBeNull();
		});

		it("discard drops the stored draft and revokes the preview", async () => {
			draftMock.state.draft = DRAFT;
			const user = userEvent.setup();
			renderPage();
			await screen.findByText(/Draft recovered/);
			await waitFor(() =>
				expect(document.querySelector('audio[src="blob:draft-audio"]')).not.toBeNull(),
			);
			await user.click(screen.getByText("Discard"));
			expect(draftMock.store.clear).toHaveBeenCalled();
			expect(screen.queryByText(/Draft recovered/)).toBeNull();
			expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:draft-audio");
		});

		it("restored audio keeps a player by the transcript until save", async () => {
			draftMock.state.draft = DRAFT;
			const user = userEvent.setup();
			renderPage();
			await screen.findByText(/Draft recovered/);
			await waitFor(() =>
				expect(document.querySelector('audio[src="blob:draft-audio"]')).not.toBeNull(),
			);
			await user.click(screen.getByText("Restore draft"));
			// banner gone; the "Draft audio" player moved to the transcript card
			expect(screen.queryByText(/Draft recovered/)).toBeNull();
			await screen.findByText("Draft audio");
			expect(document.querySelector('audio[src="blob:draft-audio"]')).not.toBeNull();
		});

		it("restored draft without a listed patient keeps the current pick", async () => {
			draftMock.state.draft = { ...DRAFT, patientId: 999 };
			const user = userEvent.setup();
			renderPage();
			await screen.findByText(/Draft recovered/);
			await user.click(screen.getByText("Restore draft"));
			expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toContain(
				"rascunho recuperado",
			);
		});

		it("no banner when there is nothing stored", async () => {
			renderPage();
			await waitFor(() => expect(draftMock.store.load).toHaveBeenCalled());
			expect(screen.queryByText(/Draft recovered/)).toBeNull();
		});

		it("finishing a mic recording persists the blob + transcript", async () => {
			micRecFn = vi.fn(async (): Promise<Blob | null> => new Blob(["audio"]));
			const user = userEvent.setup();
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "tem febre" }));
			await waitFor(() =>
				expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toContain(
					"Doctor: tem febre",
				),
			);
			act(() => micCb!({ type: "end" }));
			await waitFor(() => expect(draftMock.store.save).toHaveBeenCalled());
			const saved = draftMock.store.save.mock.calls[0]![0] as {
				audio: Blob;
				transcript: string;
			};
			expect(saved.audio.size).toBeGreaterThan(0);
			expect(saved.transcript).toContain("tem febre");
		});

		it("tab-capture end also persists the draft", async () => {
			tabRecFn = vi.fn(async (): Promise<Blob | null> => new Blob(["tab"]));
			const user = userEvent.setup();
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Capture call tab"));
			act(() => tabCb!({ type: "end" }));
			await waitFor(() => expect(draftMock.store.save).toHaveBeenCalled());
		});

		it("a successful save clears the draft", async () => {
			draftMock.state.draft = DRAFT;
			const user = userEvent.setup();
			const api = makeApi();
			renderPage(api);
			await consent(user);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await waitFor(() => expect(draftMock.store.clear).toHaveBeenCalled());
		});

		it("saving after a draft restore revokes the restored audio url", async () => {
			draftMock.state.draft = DRAFT;
			const user = userEvent.setup();
			const api = makeApi();
			renderPage(api);
			await screen.findByText(/Draft recovered/);
			await user.click(screen.getByText("Restore draft"));
			await consent(user);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:draft-audio"));
		});

		it("draft without blob URL support still restores and discards", async () => {
			draftMock.state.draft = DRAFT;
			// jsdom default: no URL.createObjectURL — the banner renders
			// without the audio preview.
			URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
			const user = userEvent.setup();
			renderPage();
			await screen.findByText(/Draft recovered/);
			expect(document.querySelector('audio[src="blob:draft-audio"]')).toBeNull();
			await user.click(screen.getByText("Discard"));
			expect(draftMock.store.clear).toHaveBeenCalled();
			expect(screen.queryByText(/Draft recovered/)).toBeNull();
		});

		it("ignores a draft that resolves after unmount", async () => {
			let resolve!: (d: unknown) => void;
			draftMock.store.load.mockImplementationOnce(
				() =>
					new Promise((r) => {
						resolve = r as (d: unknown) => void;
					}),
			);
			const { unmount } = renderPage();
			unmount();
			resolve(DRAFT);
		});
	});

	describe("patient portal access, decided up front (T-258)", () => {
		type Access = NonNullable<NewConsultationApi["patientAccess"]>;
		type Invite = NonNullable<NewConsultationApi["invitePatient"]>;

		const accessApi = (overrides: Partial<NewConsultationApi> = {}) =>
			makeApi({
				patientAccess: vi.fn<Access>(async () => ({ email: "maria@ktb.test", hasAccess: false })),
				invitePatient: vi.fn<Invite>(async () => ({ ok: true, emailed: true })),
				...overrides,
			});

		const CARD_NONE = "Maria doesn't have patient portal access yet.";
		const SEND = "Send access by email when saving";
		const SKIP = "Don't send for now";
		const QUESTION = "Send Maria the patient portal access email?";
		const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLElement;
		const cardEmail = () => screen.getByLabelText("Patient email") as HTMLInputElement;
		const retryEmail = () => screen.getByLabelText(QUESTION) as HTMLInputElement;

		/** Pick Maria and wait for her access card. */
		async function pickMaria(api: NewConsultationApi) {
			const user = userEvent.setup();
			renderPage(api);
			await choosePatient(user, "Maria");
			return user;
		}

		async function saveNow(user: ReturnType<typeof userEvent.setup>) {
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
		}

		it("asks before the visit and sends on save to the address on record", async () => {
			const api = accessApi();
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			expect(api["patientAccess"]).toHaveBeenCalledWith({ data: 1 });
			// An email on record defaults the card to "send".
			expect(radio(SEND).getAttribute("aria-checked")).toBe("true");
			expect(cardEmail().value).toBe("maria@ktb.test");
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			await saveNow(user);
			expect(api["invitePatient"]).toHaveBeenCalledWith({
				data: { patientId: 1, email: "maria@ktb.test" },
			});
			await screen.findByText("Access email sent to maria@ktb.test.");
			expect(screen.queryByLabelText(QUESTION)).toBeNull();
			expect(screen.getByText("Confirm")).toBeTruthy();
		});

		it("waits for the doctor to type an address when the record has none", async () => {
			const api = accessApi({
				patientAccess: vi.fn<Access>(async () => ({ email: null, hasAccess: false })),
			});
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			expect(radio(SKIP).getAttribute("aria-checked")).toBe("true");
			expect(screen.queryByLabelText("Patient email")).toBeNull();
			await user.click(radio(SEND));
			await user.type(cardEmail(), "maria@nova");
			expect(screen.getByText("Enter a valid email address.")).toBeTruthy();
			await user.type(cardEmail(), ".test ");
			expect(screen.queryByText("Enter a valid email address.")).toBeNull();
			await saveNow(user);
			expect(api["invitePatient"]).toHaveBeenCalledWith({
				data: { patientId: 1, email: "maria@nova.test" },
			});
			await screen.findByText("Access email sent to maria@nova.test.");
		});

		it("sends nothing and asks nothing when the doctor chose not to send", async () => {
			const api = accessApi();
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			await user.click(radio(SKIP));
			await saveNow(user);
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			expect(screen.queryByLabelText(QUESTION)).toBeNull();
			expect(screen.getByText("Confirm")).toBeTruthy();
		});

		it("turns an unusable up-front email into the dialog's retry form", async () => {
			const api = accessApi({
				patientAccess: vi.fn<Access>(async () => ({ email: null, hasAccess: false })),
			});
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			await user.click(radio(SEND));
			await saveNow(user);
			// "Send" with no address: ask for it, no error yet.
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			expect(retryEmail().value).toBe("");
			expect(screen.queryByText("Enter a valid email address.")).toBeNull();
			// Nothing to send to yet.
			fireEvent.submit(retryEmail().closest("form")!);
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			await user.type(retryEmail(), "maria@nova.test");
			await user.click(screen.getByText("Send access email"));
			await screen.findByText("Access email sent to maria@nova.test.");
		});

		it("flags a malformed up-front email in the dialog without calling the api", async () => {
			const api = accessApi({
				patientAccess: vi.fn<Access>(async () => ({ email: null, hasAccess: false })),
			});
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			await user.click(radio(SEND));
			await user.type(cardEmail(), "not-an-email");
			await saveNow(user);
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			expect(retryEmail().value).toBe("not-an-email");
			expect(screen.getAllByText("Enter a valid email address.").length).toBeGreaterThan(0);
			expect(screen.getByText("Not now")).toBeTruthy();
		});

		it("shows no card and asks nothing without a linked patient", async () => {
			const api = accessApi();
			const user = userEvent.setup();
			renderPage(api);
			await saveNow(user);
			expect(api["patientAccess"]).not.toHaveBeenCalled();
			expect(screen.queryByText(SEND)).toBeNull();
			expect(screen.queryByText("Send access email")).toBeNull();
			expect(screen.getByText("Confirm")).toBeTruthy();
		});

		it("just reassures when the patient already has portal access", async () => {
			const api = accessApi({
				patientAccess: vi.fn<Access>(async () => ({ email: "maria@ktb.test", hasAccess: true })),
			});
			const user = await pickMaria(api);
			await screen.findByText(
				"Maria already has portal access — this consultation shows up there once saved.",
			);
			expect(screen.queryByText(SEND)).toBeNull();
			await saveNow(user);
			expect(api["invitePatient"]).not.toHaveBeenCalled();
			expect(screen.queryByText("Send access email")).toBeNull();
			expect(screen.getByText("Confirm")).toBeTruthy();
		});

		it.each([
			["is unavailable", vi.fn<Access>(async () => null)],
			[
				"fails",
				vi.fn<Access>(async () => {
					throw new Error("network");
				}),
			],
		])(
			"shows no card and saves without asking when the lookup %s",
			async (_label, patientAccess) => {
				const user = await pickMaria(accessApi({ patientAccess }));
				await waitFor(() => expect(patientAccess).toHaveBeenCalled());
				await saveNow(user);
				expect(screen.queryByText(SEND)).toBeNull();
				expect(screen.queryByText("Send access email")).toBeNull();
			},
		);

		it.each([
			["maria@ktb.test", "maria@ktb.test"],
			[null, ""],
		])(
			"falls back to asking after save while the up-front lookup is pending (email %s)",
			async (email, shown) => {
				const patientAccess = vi
					.fn<Access>()
					.mockReturnValueOnce(new Promise(() => {}))
					.mockResolvedValueOnce({ email, hasAccess: false });
				const user = await pickMaria(accessApi({ patientAccess }));
				await saveNow(user);
				expect(patientAccess).toHaveBeenCalledTimes(2);
				expect(retryEmail().value).toBe(shown);
			},
		);

		it("is not offered by hosts that wire no portal access api", async () => {
			const user = userEvent.setup();
			renderPage(makeApi());
			await choosePatient(user, "Maria");
			await saveNow(user);
			expect(screen.queryByText(SEND)).toBeNull();
			expect(screen.queryByText("Send access email")).toBeNull();
			cleanup();
			const lookupOnly = accessApi({ invitePatient: undefined });
			const user2 = userEvent.setup();
			renderPage(lookupOnly);
			await choosePatient(user2, "Maria");
			fireEvent.change(screen.getByLabelText("New patient name"), { target: { value: "Ana" } });
			expect(screen.queryByText("Send consultation access by email?")).toBeNull();
			await saveNow(user2);
			expect(lookupOnly["patientAccess"]).not.toHaveBeenCalled();
		});

		it("says so when access was granted but the email could not be sent", async () => {
			const api = accessApi({
				invitePatient: vi.fn<Invite>(async () => ({ ok: true, emailed: false })),
			});
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			await saveNow(user);
			await screen.findByText(/Portal access granted to maria@ktb.test, but the email could not/);
			expect(screen.queryByText(/Access email sent/)).toBeNull();
			expect(screen.getByText("Confirm")).toBeTruthy();
		});

		it("offers a retry after a refused or failed send", async () => {
			const invitePatient = vi
				.fn<Invite>()
				.mockResolvedValueOnce({ ok: false, error: "invalid_email" })
				.mockResolvedValueOnce({ ok: false, error: "failed" })
				.mockRejectedValueOnce(new Error("network"))
				.mockResolvedValueOnce({ ok: true, emailed: true });
			const user = await pickMaria(accessApi({ invitePatient }));
			await screen.findByText(CARD_NONE);
			await saveNow(user);
			await screen.findByText("Enter a valid email address.");
			expect(retryEmail().value).toBe("maria@ktb.test");
			await user.click(screen.getByText("Send access email"));
			await screen.findByText("Could not send the access email. Please try again.");
			await user.click(screen.getByText("Send access email"));
			await waitFor(() => expect(invitePatient).toHaveBeenCalledTimes(3));
			expect(screen.getByText("Could not send the access email. Please try again.")).toBeTruthy();
			expect(screen.getByText("Not now")).toBeTruthy();
			await user.click(screen.getByText("Send access email"));
			await screen.findByText("Access email sent to maria@ktb.test.");
		});

		it("locks the retry button and ignores a second submit while sending", async () => {
			let release: (value: { ok: true; emailed: boolean }) => void = () => {};
			const invitePatient = vi
				.fn<Invite>()
				.mockResolvedValueOnce({ ok: false, error: "failed" })
				.mockImplementationOnce(
					() => new Promise<{ ok: true; emailed: boolean }>((resolve) => (release = resolve)),
				);
			const user = await pickMaria(accessApi({ invitePatient }));
			await screen.findByText(CARD_NONE);
			await saveNow(user);
			await screen.findByText("Could not send the access email. Please try again.");
			await user.click(screen.getByText("Send access email"));
			const button = screen.getByText("Send access email").closest("button")!;
			expect(button.disabled).toBe(true);
			fireEvent.submit(retryEmail().closest("form")!);
			expect(invitePatient).toHaveBeenCalledTimes(2);
			await act(async () => release({ ok: true, emailed: true }));
			await screen.findByText("Access email sent to maria@ktb.test.");
		});

		it("never invites twice when the consultation is saved again", async () => {
			const api = accessApi();
			const user = await pickMaria(api);
			await screen.findByText(CARD_NONE);
			await saveNow(user);
			await screen.findByText("Access email sent to maria@ktb.test.");
			await user.click(screen.getByText("Confirm"));
			// The card now reflects the granted access.
			await screen.findByText(
				"Maria already has portal access — this consultation shows up there once saved.",
			);
			await user.click(screen.getByText("Update consultation"));
			await screen.findByText("Consultation updated");
			expect(api["invitePatient"]).toHaveBeenCalledTimes(1);
			expect(api["patientAccess"]).toHaveBeenCalledTimes(1);
			expect(screen.queryByText(/Access email sent/)).toBeNull();
		});

		describe("quick-created patient", () => {
			type Create = NewConsultationApi["createPatient"];
			const created = (id: number, name: string) =>
				vi.fn<Create>(async () => ({ ok: true, patient: { id, name } }));

			async function quickCreate(
				api: NewConsultationApi,
				answer: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
			) {
				const user = userEvent.setup();
				renderPage(api);
				expect(screen.queryByText("Send consultation access by email?")).toBeNull();
				fireEvent.change(screen.getByLabelText("New patient name"), { target: { value: "Ana" } });
				// The question appears once a name is typed, "Yes" first.
				await screen.findByText("Send consultation access by email?");
				expect(radio("Yes").getAttribute("aria-checked")).toBe("true");
				await answer(user);
				fireEvent.change(screen.getByLabelText("New patient age"), { target: { value: "30" } });
				await user.click(screen.getByText("+ patient"));
				await screen.findByText("Ana doesn't have patient portal access yet.");
				return user;
			}

			it("carries the typed email into the card and sends it on save", async () => {
				const api = accessApi({ createPatient: created(9, "Ana") });
				const user = await quickCreate(api, async (u) => {
					await u.type(screen.getByLabelText("Patient email"), "ana@ktb.test");
				});
				// A new patient needs no lookup — the answer is already known.
				expect(api["patientAccess"]).not.toHaveBeenCalled();
				expect(radio(SEND).getAttribute("aria-checked")).toBe("true");
				expect(cardEmail().value).toBe("ana@ktb.test");
				expect(screen.queryByText("Send consultation access by email?")).toBeNull();
				await saveNow(user);
				expect(api["invitePatient"]).toHaveBeenCalledWith({
					data: { patientId: 9, email: "ana@ktb.test" },
				});
			});

			it("answering no leaves the card on don't send", async () => {
				const api = accessApi({ createPatient: created(9, "Ana") });
				const user = await quickCreate(api, async (u) => {
					await u.click(radio("No"));
					expect(screen.queryByLabelText("Patient email")).toBeNull();
				});
				expect(radio(SKIP).getAttribute("aria-checked")).toBe("true");
				await saveNow(user);
				expect(api["invitePatient"]).not.toHaveBeenCalled();
				expect(screen.queryByText("Send access email")).toBeNull();
			});

			it("yes without a usable email stays undecided on the card", async () => {
				const api = accessApi({ createPatient: created(9, "Ana") });
				await quickCreate(api, async (u) => {
					await u.type(screen.getByLabelText("Patient email"), "ana@");
				});
				expect(radio(SKIP).getAttribute("aria-checked")).toBe("true");
			});
		});
	});

	describe("post-consultation dictation", () => {
		async function enterDictation(user: ReturnType<typeof userEvent.setup>) {
			await user.click(screen.getByText("Post-consultation dictation"));
		}

		it("switches mode and shows dictation panel without source tabs", async () => {
			const user = userEvent.setup();
			renderPage();
			await enterDictation(user);
			expect(screen.getByText(/Narrate everything out loud/)).toBeTruthy();
			expect(screen.getByText("Start dictation")).toBeTruthy();
			expect(screen.queryByText("Teleconsult (bot)")).toBeNull();
			await user.click(screen.getByText("Live consultation"));
			expect(screen.getByText("Teleconsult (bot)")).toBeTruthy();
			expect(screen.queryByText("Start dictation")).toBeNull();
		});

		it("requires consent and shows warning", async () => {
			const user = userEvent.setup();
			renderPage();
			await enterDictation(user);
			expect(screen.getByText(/Check the consent box above to enable dictation/)).toBeTruthy();
			const btn = screen.getByText("Start dictation").closest("button")!;
			expect(btn.disabled).toBe(true);
			await consent(user);
			expect(btn.disabled).toBe(false);
			expect(screen.queryByText(/enable dictation/)).toBeNull();
		});

		it("shows unsupported message when mic unsupported", async () => {
			micSupported = false;
			const user = userEvent.setup();
			renderPage();
			await enterDictation(user);
			expect(screen.getByText(/Recording is not supported/)).toBeTruthy();
		});

		it("records narration: partial preview, final without prefix, stop", async () => {
			const user = userEvent.setup();
			renderPage();
			await consent(user);
			await enterDictation(user);
			await user.click(screen.getByText("Start dictation"));
			expect(micCb).not.toBeNull();
			expect(screen.getByText(/recording… 0:00/)).toBeTruthy();

			act(() => micCb!({ type: "partial", text: "narração parcial" }));
			await screen.findByText(/narração parcial…/);
			act(() => micCb!({ type: "final", text: "paciente relata dor de cabeça" }));
			act(() => micCb!({ type: "final", text: "sem febre" }));
			await waitFor(() =>
				expect((screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value).toBe(
					"paciente relata dor de cabeça\nsem febre",
				),
			);

			await user.click(screen.getByText(/Stop dictation/));
			expect(micStop).toHaveBeenCalled();
			expect(screen.getByText("Start dictation")).toBeTruthy();
			expect(screen.queryByText(/recording…/)).toBeNull();
		});

		it("elapsed clock ticks while dictating", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const user = userEvent.setup({
				advanceTimers: (ms) => vi.advanceTimersByTime(ms),
			});
			renderPage();
			await consent(user);
			await enterDictation(user);
			await user.click(screen.getByText("Start dictation"));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(61_500);
			});
			expect(screen.getByText(/Stop dictation \(1:01\)/)).toBeTruthy();
			vi.useRealTimers();
		});

		it("dictation error and end events stop recording", async () => {
			const user = userEvent.setup();
			renderPage();
			await consent(user);
			await enterDictation(user);
			await user.click(screen.getByText("Start dictation"));
			act(() => micCb!({ type: "error", message: "dict mic denied" }));
			await screen.findByText("dict mic denied");
			expect(screen.getByText("Start dictation")).toBeTruthy();
			// restart, then engine end stops it
			await user.click(screen.getByText("Start dictation"));
			act(() => micCb!({ type: "end" }));
			expect(screen.getByText("Start dictation")).toBeTruthy();
		});

		it("dictated transcript feeds the anamnesis pipeline", async () => {
			const user = userEvent.setup();
			const api = makeApi();
			renderPage(api);
			await consent(user);
			await enterDictation(user);
			await user.click(screen.getByText("Start dictation"));
			act(() => micCb!({ type: "final", text: "narrei a consulta toda" }));
			await user.click(screen.getByText(/Stop dictation/));
			await user.click(screen.getByText("Generate anamnesis →"));
			await screen.findByText("high confidence");
			expect(api["extractAnamnesis"]).toHaveBeenCalledWith({
				data: { transcript: "narrei a consulta toda", patientId: undefined },
			});
		});
	});

	describe("server fallback on low confidence", () => {
		const LOW: SessionStats = { voicedSec: 10, chars: 5 };
		const HIGH: SessionStats = { voicedSec: 10, chars: 200 };
		const blob = new Blob(["audio"], { type: "audio/webm" });

		function transcriptValue() {
			return (screen.getByLabelText("Consultation text") as HTMLTextAreaElement).value;
		}

		async function flushFallback() {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});
		}

		it("mic session re-transcribes on the server and keeps the Doctor label", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn(async () => ({
				ok: true,
				json: async () => ({ text: "transcrição do servidor" }),
			}));
			vi.stubGlobal("fetch", fetchMock);
			micStatsFn = () => LOW;
			micRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "lixo local" }));
			act(() => micCb!({ type: "end" }));
			await waitFor(() => expect(transcriptValue()).toBe("Doctor: transcrição do servidor"));
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/transcribe",
				expect.objectContaining({ method: "POST" }),
			);
		});

		it("splices the server result after pre-existing transcript", async () => {
			const user = userEvent.setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: true,
					json: async () => ({ text: "só o trecho novo" }),
				})),
			);
			micStatsFn = () => LOW;
			micRecFn = async () => blob;
			renderPage();
			fireEvent.change(screen.getByLabelText("Consultation text"), {
				target: { value: "anotação anterior" },
			});
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "lixo local" }));
			act(() => micCb!({ type: "end" }));
			await waitFor(() =>
				expect(transcriptValue()).toBe("anotação anterior\nDoctor: só o trecho novo"),
			);
		});

		it("tab session falls back with the Patient label", async () => {
			const user = userEvent.setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: true,
					json: async () => ({ text: "paciente no servidor" }),
				})),
			);
			tabStatsFn = () => LOW;
			tabRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Capture call tab"));
			act(() => tabCb!({ type: "final", text: "lixo" }));
			act(() => tabCb!({ type: "end" }));
			await waitFor(() => expect(transcriptValue()).toBe("Patient: paciente no servidor"));
		});

		it("dictation falls back without a speaker label", async () => {
			const user = userEvent.setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: true,
					json: async () => ({ text: "narração refeita" }),
				})),
			);
			micStatsFn = () => LOW;
			micRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Post-consultation dictation"));
			await user.click(screen.getByText("Start dictation"));
			act(() => micCb!({ type: "final", text: "lixo local" }));
			act(() => micCb!({ type: "end" }));
			await waitFor(() => expect(transcriptValue()).toBe("narração refeita"));
		});

		it("does not fall back when confidence is healthy", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			micStatsFn = () => HIGH;
			micRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "transcrição boa" }));
			act(() => micCb!({ type: "end" }));
			await flushFallback();
			await waitFor(() => expect(transcriptValue()).toBe("Doctor: transcrição boa"));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("does not fall back without a recording to upload", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			micStatsFn = () => LOW;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "end" }));
			await flushFallback();
			await waitFor(() => expect(screen.getByText("Record microphone")).toBeTruthy());
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("keeps the local transcript when the recording is empty", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			micStatsFn = () => LOW;
			micRecFn = async () => null;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "local fica" }));
			act(() => micCb!({ type: "end" }));
			await flushFallback();
			await waitFor(() => expect(transcriptValue()).toBe("Doctor: local fica"));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("keeps the local transcript when the server returns empty text", async () => {
			const user = userEvent.setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: true, json: async () => ({ text: "   " }) })),
			);
			micStatsFn = () => LOW;
			micRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "local fica" }));
			act(() => micCb!({ type: "end" }));
			await flushFallback();
			await waitFor(() => expect(transcriptValue()).toBe("Doctor: local fica"));
		});

		it("keeps the local transcript when the upload fails", async () => {
			const user = userEvent.setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("network down");
				}),
			);
			micStatsFn = () => LOW;
			micRecFn = async () => blob;
			renderPage();
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "local fica" }));
			act(() => micCb!({ type: "end" }));
			await flushFallback();
			await waitFor(() => expect(transcriptValue()).toBe("Doctor: local fica"));
		});
	});

	describe("audio upload + server transcript", () => {
		const audioBlob = new Blob(["audio"], { type: "audio/webm" });

		function audioDetail(over: Record<string, unknown> = {}) {
			return {
				id: 42,
				transcript: "paciente relata dor",
				audioKey: "audio/u/42/x.webm",
				audioStatus: "queued",
				serverTranscript: null,
				correctedTranscript: null,
				...over,
			};
		}

		it("uploads the session recording after save and tracks the pipeline", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
			tabRecFn = async () => audioBlob;
			const api = makeApi({
				getConsultation: vi
					.fn()
					.mockResolvedValueOnce(audioDetail())
					.mockResolvedValue(
						audioDetail({
							audioStatus: "done",
							serverTranscript: "server raw",
							correctedTranscript: "clean corrected",
						}),
					),
			});
			const fetchMock = vi.fn(async () => ({
				ok: true,
				json: async () => ({ ok: true, audioStatus: "queued" }),
			}));
			vi.stubGlobal("fetch", fetchMock);
			renderPage(api);
			await consent(user);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");

			await waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith(
					"/api/consultations/42/audio",
					expect.objectContaining({ method: "POST" }),
				),
			);
			await screen.findByText(/enhancing transcript/);

			// pipeline finishes → corrected transcript appears (default tab)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3100);
			});
			await screen.findByText("clean corrected");
			expect(screen.getByText("enhanced ✓")).toBeTruthy();

			// generate uses the text on the viewed (corrected) tab
			await user.click(screen.getByText("Generate anamnesis →"));
			await waitFor(() =>
				expect(api["extractAnamnesis"]).toHaveBeenLastCalledWith({
					data: { transcript: "clean corrected", patientId: undefined },
				}),
			);
			expect(screen.getByText(/llm corrected transcript/)).toBeTruthy();

			// original tab exposes the raw ASR outputs
			await user.click(screen.getByText("Original"));
			await screen.findByText("server raw");
			await screen.findByText("server · whisper large-v3-turbo");
			// browser transcript also appears in the editable textarea
			expect(screen.getAllByText("paciente relata dor").length).toBeGreaterThan(1);
			vi.useRealTimers();
		});

		it("audio upload failure warns but does not block saving", async () => {
			const user = userEvent.setup();
			micRecFn = async () => audioBlob;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: false, status: 500 })),
			);
			renderPage();
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await screen.findByText(/Audio could not be uploaded/);
		});

		it("uploads once per consultation even when saved again", async () => {
			const user = userEvent.setup();
			micRecFn = async () => audioBlob;
			const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
			vi.stubGlobal("fetch", fetchMock);
			renderPage();
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith("/api/consultations/42/audio", expect.anything()),
			);
			await user.click(screen.getByText("Confirm"));
			await user.click(screen.getByText("Update consultation"));
			await screen.findByText("Consultation updated");
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});
			const audioCalls = fetchMock.mock.calls.filter(
				(c) => (c as unknown[])[0] === "/api/consultations/42/audio",
			);
			expect(audioCalls).toHaveLength(1);
		});

		it("falls back to audio/webm when the recording has no mime type", async () => {
			const user = userEvent.setup();
			micRecFn = async () => new Blob(["audio"]);
			const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
			vi.stubGlobal("fetch", fetchMock);
			renderPage();
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith(
					"/api/consultations/42/audio",
					expect.objectContaining({ headers: { "content-type": "audio/webm" } }),
				),
			);
		});

		it("reports a generic reason when the upload fails with a non-Error", async () => {
			const user = userEvent.setup();
			micRecFn = async () => audioBlob;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw "offline";
				}),
			);
			renderPage();
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await screen.findByText(/Audio could not be uploaded \(error\)/);
		});

		it("does not call the audio endpoint without a recording", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			renderPage();
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});
			expect(fetchMock).not.toHaveBeenCalledWith("/api/consultations/42/audio", expect.anything());
		});
	});

	describe("ZK save paths (T-145)", () => {
		const zk = { keyring: { tag: "k" }, api: { tag: "a" } } as never;

		it("encrypts the draft and signs the version for a new consultation", async () => {
			const api = makeApi();
			zkMocks.extractAnamnesisZk.mockResolvedValueOnce({
				anamnesis: ANAMNESIS,
				engine: "heuristic",
			});
			const user = userEvent.setup();
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					api={api}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			expect(zkMocks.newConsultationDek).toHaveBeenCalledWith({ tag: "k" }, { tag: "a" });
			expect(api.saveConsultation).toHaveBeenCalledWith({
				data: expect.objectContaining({
					transcript: "v1.t.e",
					anamnesis: "v1.a.e",
					ciphered: true,
					grants: [{ readerKind: "device", readerPubkey: "w", wrappedDek: "w1.g" }],
					version: { contentHash: "h1", signature: "s1" },
				}),
			});
			expect(api.attachAnamnesis).not.toHaveBeenCalled();
		});

		it("ignores an agenda shell to resume — it has no DEK to encrypt under", async () => {
			const api = makeApi();
			zkMocks.extractAnamnesisZk.mockResolvedValueOnce({
				anamnesis: ANAMNESIS,
				engine: "heuristic",
			});
			const user = userEvent.setup();
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					resumeConsultationId={42}
					api={api}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			expect(api["saveConsultation"]).toHaveBeenCalled();
			expect(api["attachAnamnesis"]).not.toHaveBeenCalled();
		});

		it("encrypts only the anamnesis under the record DEK on update", async () => {
			const api = makeApi();
			zkMocks.extractAnamnesisZk.mockResolvedValue({
				anamnesis: ANAMNESIS,
				engine: null as never,
			});
			const user = userEvent.setup();
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					api={api}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			await user.click(screen.getByText("Update consultation"));
			await waitFor(() =>
				expect(api.attachAnamnesis).toHaveBeenCalledWith({
					data: expect.objectContaining({
						consultationId: 42,
						anamnesis: "v1.a2.e",
						ciphered: true,
						version: { contentHash: "h1", signature: "s1" },
					}),
				}),
			);
			expect(zkMocks.consultationDek).toHaveBeenCalledWith({ tag: "k" }, { tag: "a" }, 42);
		});

		it("surfaces the decrypt failure when the record DEK is missing", async () => {
			const api = makeApi();
			zkMocks.extractAnamnesisZk.mockResolvedValue({
				anamnesis: ANAMNESIS,
				engine: "heuristic",
			});
			const user = userEvent.setup();
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					api={api}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await generateAnamnesis(user);
			await user.click(screen.getByText("Save consultation"));
			await screen.findByText("Anamnesis saved successfully");
			zkMocks.consultationDek.mockResolvedValueOnce(null);
			await user.click(screen.getByText("Update consultation"));
			await screen.findByText(/decrypt/i);
		});

		it("shows the transcription error when ZK extraction returns null", async () => {
			zkMocks.extractAnamnesisZk.mockResolvedValueOnce(null);
			const user = userEvent.setup();
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					api={makeApi()}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await fillTranscript();
			await user.click(screen.getByText("Generate anamnesis →"));
			await screen.findByText(/transcription failed/);
		});

		it("never falls back to server-side re-transcription under ZK", async () => {
			const user = userEvent.setup();
			const fetchMock = vi.fn(async () => ({
				ok: true,
				json: async () => ({ text: "servidor" }),
			}));
			vi.stubGlobal("fetch", fetchMock);
			micStatsFn = () => ({ voicedSec: 10, chars: 5 });
			micRecFn = async () => new Blob(["audio"], { type: "audio/webm" });
			render(
				<NewConsultationPage
					initialPatients={PATIENTS}
					api={makeApi()}
					backend={backend}
					zk={zk}
					liveFlow={false}
				/>,
			);
			await consent(user);
			await user.click(screen.getByText("Record microphone"));
			act(() => micCb!({ type: "final", text: "lixo local" }));
			act(() => micCb!({ type: "end" }));
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});
			expect(fetchMock).not.toHaveBeenCalledWith("/api/transcribe", expect.anything());
		});
	});

	describe("live flow — pre-consultation room and live screen", () => {
		const ROOM_CONSENT = /duly informed and consented/;

		async function roomConsent(user: ReturnType<typeof userEvent.setup>) {
			await user.click(await screen.findByText(ROOM_CONSENT));
		}

		it("shows the room, gates start on consent and reflects the patient", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, 1, undefined, undefined, true, "Dr. House");
			expect(screen.getByText("Ready to start the consultation?")).toBeTruthy();
			expect(screen.getAllByText(/Dr\. House/).length).toBeGreaterThan(0);
			expect(screen.getAllByText("Maria").length).toBeGreaterThan(0);
			expect(screen.getByText("Start Session").closest("button")!.disabled).toBe(true);
			await roomConsent(user);
			// the CTA unmounts its disabled Tooltip wrapper once enabled —
			// re-query instead of holding the old node
			expect(screen.getByText("Start Session").closest("button")!.disabled).toBe(false);
		});

		it("in-person start begins mic capture and swaps to the live screen", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true, "Dr. House");
			await roomConsent(user);
			await user.click(screen.getByText("Start Session"));
			expect(micCb).not.toBeNull();
			expect(screen.queryByText("Ready to start the consultation?")).toBeNull();
			expect(screen.getByText("Live Consultation Transcript")).toBeTruthy();
			expect(screen.getByText("End Consultation")).toBeTruthy();

			// mic finals render as clinician turns named after the physician
			act(() => micCb!({ type: "final", text: "bom dia" }));
			await screen.findByText("Dr. House");
			act(() => micCb!({ type: "partial", text: "como" }));
			await screen.findByText(/como/);

			// ending returns to the workspace — the room does not reappear
			await user.click(screen.getByText("End Consultation"));
			expect(micStop).toHaveBeenCalled();
			expect(screen.getByLabelText("Consultation text")).toBeTruthy();
			expect(screen.queryByText("Ready to start the consultation?")).toBeNull();
		});

		it("telemedicine modality starts tab capture", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, 2, undefined, undefined, true);
			await roomConsent(user);
			await user.click(screen.getByRole("radio", { name: "Teleconsult" }));
			await user.click(screen.getByText("Start Session"));
			expect(tabCb).not.toBeNull();
			expect(micCb).toBeNull();
			expect(screen.getByText("Live Consultation Transcript")).toBeTruthy();
		});

		it("the secondary action switches to dictation mode", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await user.click(screen.getByText("Quick post-consultation dictation"));
			expect(screen.getByText("Start dictation")).toBeTruthy();
			expect(screen.queryByText("Ready to start the consultation?")).toBeNull();
		});

		it("change patient reveals the picker and updates the room card", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, 1, undefined, undefined, true);
			await user.click(screen.getAllByText("Change")[0]!);
			await screen.findByText("Done");
			// The picker's Select is a Base UI combobox; in jsdom its trigger
			// does not reliably open under user-event's full pointer sequence
			// (pointer capture + focus), so drive the open with fireEvent.
			const trigger = screen.getByRole("combobox", { name: "Patient" });
			fireEvent.pointerDown(trigger);
			fireEvent.mouseDown(trigger);
			fireEvent.mouseUp(trigger);
			fireEvent.click(trigger);
			await user.click(await screen.findByRole("option", { name: "João" }));
			expect(screen.getAllByText("João").length).toBeGreaterThan(0);
			await user.click(screen.getByText("Done"));
			// Base UI's Presence keeps the popup mounted in jsdom until the
			// exit animation ends (which never fires without CSS) — assert the
			// closed state instead of unmount.
			await vi.waitFor(() => {
				const popup = document.querySelector('[data-slot="dialog-content"]');
				expect(popup === null || popup.hasAttribute("data-closed")).toBe(true);
			});
		});

		it("user menu opens and items navigate inside the portal", async () => {
			renderPage(makeApi(), PATIENTS, undefined, undefined, "/portal/doctor", true, "Dr. House", {
				name: "Admin",
				email: "admin@ktb.health",
			});
			// fireEvent over user-event: Base UI menus are timing-sensitive
			// in jsdom under full-suite load; the regression this guards is
			// the MenuGroupLabel crash on open, not pointer fidelity.
			fireEvent.click(screen.getByText("Admin"));
			const menu = await screen.findByRole("menu", {}, { timeout: 3000 });
			expect(within(menu).getByText("admin@ktb.health")).toBeTruthy();
			fireEvent.click(within(menu).getByText("Patients"));
			expect(navigateMock).toHaveBeenCalledWith({ to: "/portal/doctor/patients" });
		});

		it("audio settings gear opens the device dialog", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await user.click(screen.getByRole("button", { name: "Audio settings" }));
			expect(await screen.findByText("Audio settings")).toBeTruthy();
			expect(screen.getByText("Input device")).toBeTruthy();
		});

		it("audio test warms the transcription engine", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await user.click(screen.getAllByText("Test audio (3s)")[0]!);
			expect(backendLoad).toHaveBeenCalled();
		});

		it("user menu navigates to every portal section", async () => {
			renderPage(makeApi(), PATIENTS, undefined, undefined, "/portal/doctor", true, "Dr. House", {
				name: "Admin",
				email: "admin@ktb.health",
			});
			// the open menu also renders an "Admin" label — target the
			// trigger button specifically.
			const openMenu = async () => {
				fireEvent.click(screen.getAllByRole("button", { name: /Admin/ })[0]!);
				// scope item clicks to the popup — "Consultations" also
				// matches the room header's back link.
				return screen.findByRole("menu", {}, { timeout: 3000 });
			};
			let menu = await openMenu();
			fireEvent.click(within(menu).getByText("Portal home"));
			expect(navigateMock).toHaveBeenCalledWith({ to: "/portal/doctor" });
			menu = await openMenu();
			fireEvent.click(within(menu).getByText("Consultations"));
			expect(navigateMock).toHaveBeenCalledWith({ to: "/portal/doctor/consultations" });
			menu = await openMenu();
			fireEvent.click(within(menu).getByText("Review queue"));
			expect(navigateMock).toHaveBeenCalledWith({ to: "/portal/doctor/review" });
		});

		it("change-patient dialog closes through its own dismiss control", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, 1, undefined, undefined, true);
			await user.click(screen.getAllByText("Change")[0]!);
			const dlg = await screen.findByText("Done");
			expect(dlg).toBeTruthy();
			// Base UI's X button — exercises Dialog onOpenChange(false).
			const popup = dlg.closest('[data-slot="dialog-content"]')!;
			fireEvent.click(within(popup as HTMLElement).getByRole("button", { name: /close/i }));
			await vi.waitFor(() => {
				const el = document.querySelector('[data-slot="dialog-content"]');
				expect(el === null || el.hasAttribute("data-closed")).toBe(true);
			});
		});

		it("audio settings dialog closes through its dismiss control", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await user.click(screen.getByRole("button", { name: "Audio settings" }));
			const title = await screen.findByText("Audio settings");
			const popup = title.closest('[data-slot="dialog-content"]')!;
			fireEvent.click(within(popup as HTMLElement).getByRole("button", { name: /close/i }));
			await vi.waitFor(() => {
				const el = document.querySelector('[data-slot="dialog-content"]');
				expect(el === null || el.hasAttribute("data-closed")).toBe(true);
			});
		});

		it("mic toggle and device chip drive the room preview controls", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await screen.findByText("Ready to start the consultation?");
			// no mediaDevices in jsdom → the device chip is the fallback
			// button that reports "" (back to system default)
			await user.click(screen.getByRole("button", { name: "Toggle microphone" }));
			await user.click(screen.getByRole("button", { name: "Room microphone" }));
		});

		it("live screen sample/clear/anamnesis controls drive capture state", async () => {
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true, "Dr. House");
			await roomConsent(user);
			await user.click(screen.getByText("Start Session"));
			expect(screen.getByText("Live Consultation Transcript")).toBeTruthy();
			await user.click(screen.getByText("Use sample"));
			const clear = screen.getByText("Clear");
			expect((clear.closest("button") as HTMLButtonElement).disabled).toBe(false);
			await user.click(clear);
			// anamnesis toggles exist in both the header and the control bar
			const anamnesisButtons = await screen.findAllByText("AI anamnesis");
			expect(anamnesisButtons.length).toBeGreaterThanOrEqual(2);
			for (const b of anamnesisButtons) {
				fireEvent.click(b.closest("button") ?? b);
			}
		});

		it("enumerates inputs, applies the picked device and runs the real mic test", async () => {
			const user = userEvent.setup();
			const trackStop = vi.fn();
			const gum = vi.fn(async () => ({
				getTracks: () => [{ stop: trackStop, kind: "audio" }],
			}));
			const enumerateDevices = vi
				.fn<() => Promise<MediaDeviceInfo[]>>()
				.mockRejectedValueOnce(new Error("denied"))
				.mockResolvedValue([
					{ kind: "audioinput", deviceId: "mic-1", label: "Mic One", groupId: "" },
					{ kind: "audioinput", deviceId: "mic-2", label: "", groupId: "" },
					{ kind: "audioinput", deviceId: "default", label: "Default", groupId: "" },
					{ kind: "videoinput", deviceId: "cam-1", label: "Cam", groupId: "" },
				] as MediaDeviceInfo[]);
			const listeners = new Set<() => void>();
			Object.defineProperty(window.navigator, "mediaDevices", {
				configurable: true,
				value: {
					enumerateDevices,
					getUserMedia: gum,
					addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
					removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
				},
			});
			class FakeAudioContext {
				destination = {};
				createMediaStreamSource() {
					return { connect: vi.fn() };
				}
				createAnalyser() {
					return {
						fftSize: 0,
						frequencyBinCount: 512,
						getByteTimeDomainData: (buf: Uint8Array) => buf.fill(200),
					};
				}
				close = vi.fn(async () => {});
			}
			vi.stubGlobal("AudioContext", FakeAudioContext);
			try {
				renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
				await screen.findByText("Ready to start the consultation?");
				// first enumerate rejects (covers the .catch) — devicechange
				// re-runs it successfully.
				await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
				for (const fn of [...listeners]) fn();
				await vi.waitFor(() =>
					expect(enumerateDevices.mock.calls.length).toBeGreaterThanOrEqual(2),
				);
				// the preview device picker now lists the real inputs —
				// wait for the audioDevices state to flush into the room.
				await vi.waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
				const previewSelect = screen.getAllByRole("combobox")[0]!;
				fireEvent.pointerDown(previewSelect);
				fireEvent.mouseDown(previewSelect);
				fireEvent.mouseUp(previewSelect);
				fireEvent.click(previewSelect);
				await user.click(await screen.findByRole("option", { name: "Mic One" }));
				// gear → settings dialog → same device → run the real test
				await user.click(screen.getByRole("button", { name: "Audio settings" }));
				const combo = await screen.findByRole("combobox", { name: "Input device" });
				fireEvent.pointerDown(combo);
				fireEvent.mouseDown(combo);
				fireEvent.mouseUp(combo);
				fireEvent.click(combo);
				await user.click(await screen.findByRole("option", { name: "Mic One" }));
				const dlg = document.querySelector('[data-slot="dialog-content"]')!;
				fireEvent.click(
					within(dlg as HTMLElement).getByRole("button", { name: "Test audio (3s)" }),
				);
				await vi.waitFor(
					() =>
						expect(gum).toHaveBeenCalledWith({
							audio: {
								echoCancellation: true,
								noiseSuppression: true,
								deviceId: { exact: "mic-1" },
							},
						}),
					{ timeout: 4000 },
				);
				await vi.waitFor(() => expect(trackStop).toHaveBeenCalled(), { timeout: 4000 });
				// reopen → System default covers the "default" arm; the dialog's
				// X exercises onOpenChange(false).
				await user.click(screen.getByRole("button", { name: "Audio settings" }));
				const combo2 = await screen.findByRole("combobox", { name: "Input device" });
				fireEvent.pointerDown(combo2);
				fireEvent.mouseDown(combo2);
				fireEvent.mouseUp(combo2);
				fireEvent.click(combo2);
				await user.click(await screen.findByRole("option", { name: "System default" }));
				const dlg2 = document.querySelector('[data-slot="dialog-content"]')!;
				fireEvent.click(within(dlg2 as HTMLElement).getByRole("button", { name: /close/i }));
			} finally {
				delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
			}
		}, 20000);

		it("mic test reports silence and swallows a second concurrent run", async () => {
			const user = userEvent.setup();
			const trackStop = vi.fn();
			const gum = vi.fn(async () => ({
				getTracks: () => [{ stop: trackStop, kind: "audio" }],
			}));
			Object.defineProperty(window.navigator, "mediaDevices", {
				configurable: true,
				value: { getUserMedia: gum },
			});
			class SilentAudioContext {
				destination = {};
				createMediaStreamSource() {
					return { connect: vi.fn() };
				}
				createAnalyser() {
					return {
						fftSize: 0,
						frequencyBinCount: 512,
						getByteTimeDomainData: (buf: Uint8Array) => buf.fill(128),
					};
				}
				close = vi.fn(async () => {});
			}
			vi.stubGlobal("AudioContext", SilentAudioContext);
			try {
				renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
				await screen.findByText("Ready to start the consultation?");
				const buttons = screen.getAllByText("Test audio (3s)");
				// two rapid clicks — the second hits the in-flight guard
				fireEvent.click(buttons[0]!);
				fireEvent.click(buttons[0]!);
				await screen.findByText(
					"Audio test failed — no sound detected. Check your microphone.",
					{},
					{ timeout: 6000 },
				);
				expect(gum).toHaveBeenCalledTimes(1);
				expect(trackStop).toHaveBeenCalled();
			} finally {
				delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
			}
		}, 20000);

		it("mic test reports a denied microphone", async () => {
			const user = userEvent.setup();
			const gum = vi.fn(async () => {
				throw new Error("denied");
			});
			Object.defineProperty(window.navigator, "mediaDevices", {
				configurable: true,
				value: { getUserMedia: gum },
			});
			class FakeAudioContext {
				destination = {};
				createMediaStreamSource() {
					return { connect: vi.fn() };
				}
				createAnalyser() {
					return {
						fftSize: 0,
						frequencyBinCount: 512,
						getByteTimeDomainData: (buf: Uint8Array) => buf.fill(200),
					};
				}
				close = vi.fn(async () => {});
			}
			vi.stubGlobal("AudioContext", FakeAudioContext);
			try {
				renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
				await screen.findByText("Ready to start the consultation?");
				await user.click(screen.getAllByText("Test audio (3s)")[0]!);
				await screen.findByText(
					"Audio test failed — microphone unavailable or permission denied.",
					{},
					{ timeout: 3000 },
				);
			} finally {
				delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
			}
		}, 15000);

		it("mic test is a no-op when the browser is unsupported", async () => {
			micSupported = false;
			const user = userEvent.setup();
			renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
			await screen.findByText("Ready to start the consultation?");
			await user.click(screen.getAllByText("Test audio (3s)")[0]!);
			expect(backendLoad).toHaveBeenCalled();
		});

		it("device enumeration resolving after unmount is ignored", async () => {
			let resolveDevices!: (v: MediaDeviceInfo[]) => void;
			const pending = new Promise<MediaDeviceInfo[]>((r) => {
				resolveDevices = r;
			});
			Object.defineProperty(window.navigator, "mediaDevices", {
				configurable: true,
				value: {
					enumerateDevices: () => pending,
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
				},
			});
			try {
				const { unmount } = renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
				await screen.findByText("Ready to start the consultation?");
				unmount();
				await act(async () => {
					resolveDevices([
						{ kind: "audioinput", deviceId: "mic-9", label: "Late Mic", groupId: "" },
					] as MediaDeviceInfo[]);
				});
			} finally {
				delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
			}
		});

		it("picker unlinks the patient then quick-creates one with an age", async () => {
			const user = userEvent.setup();
			const api = makeApi();
			renderPage(api, PATIENTS, 1, undefined, undefined, true);
			await user.click(screen.getAllByText("Change")[0]!);
			const trigger = screen.getByRole("combobox", { name: "Patient" });
			fireEvent.pointerDown(trigger);
			fireEvent.mouseDown(trigger);
			fireEvent.mouseUp(trigger);
			fireEvent.click(trigger);
			await user.click(await screen.findByRole("option", { name: "unlinked" }));
			await user.type(screen.getByLabelText("New patient name"), "Ana");
			await user.type(screen.getByLabelText("New patient age"), "42");
			await user.click(screen.getByText("+ patient"));
			expect(api["createPatient"]).toHaveBeenCalled();
			// quick-create closes the dialog; the room card shows the new patient
			expect((await screen.findAllByText("Ana")).length).toBeGreaterThan(0);
			expect(screen.getAllByText(/42/).length).toBeGreaterThan(0);
		});

		it("user menu falls back to placeholders when the account has no name", async () => {
			renderPage(makeApi(), PATIENTS, undefined, undefined, "/portal/doctor", true, "Dr. House", {
				email: "",
			});
			// avatar shows "?"; the trigger + menu labels fall back to email
			fireEvent.click(screen.getByText("?"));
			const menu = await screen.findByRole("menu", {}, { timeout: 3000 });
			expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
		});

		it("live screen shows the engine badge and surfaces generate errors", async () => {
			statusImpl = () => ({ state: "ready", device: "webgpu" });
			const user = userEvent.setup();
			const api = makeApi({
				extractAnamnesis: vi.fn(async () => {
					throw new Error("llm down");
				}),
			});
			renderPage(api, PATIENTS, undefined, undefined, undefined, true);
			await roomConsent(user);
			await user.click(screen.getByText("Start Session"));
			expect(await screen.findByText(/model ready \(webgpu\)/)).toBeTruthy();
			// a transcript final keeps the capture live; a failed generate
			// then surfaces its error inside the live strip itself.
			await vi.waitFor(() => expect(micCb).not.toBeNull());
			act(() => micCb!({ type: "final", text: "paciente relata dor" }));
			// both anamnesis toggles flip the same Sheet — one click opens it
			fireEvent.click((await screen.findAllByText("AI anamnesis"))[0]!.closest("button")!);
			await user.click(await screen.findByText("Generate anamnesis →"));
			expect(await screen.findByText("llm down")).toBeTruthy();
		});

		it("room stage floats the recovered-draft notices", async () => {
			const origCreate = URL.createObjectURL;
			URL.createObjectURL = vi.fn(() => "blob:draft-room");
			draftMock.state.draft = {
				audio: new Blob(["audio"], { type: "audio/webm" }),
				transcript: "Doctor: rascunho",
				patientId: 1,
				savedAt: Date.now(),
			};
			try {
				renderPage(makeApi(), PATIENTS, undefined, undefined, undefined, true);
				expect(await screen.findByText(/Draft recovered/)).toBeTruthy();
			} finally {
				URL.createObjectURL = origCreate;
			}
		});
	});

	describe("liveConsultationTurns", () => {
		const opts = { doctor: "Doctor", patient: "Patient", doctorName: "Dr. House" };

		it("groups consecutive rows into speaker turns", () => {
			const turns = liveConsultationTurns(
				[
					{ speaker: "Doctor", name: "Doctor", text: "hi", time: "0:01" },
					{ speaker: "Doctor", name: "Doctor", text: "there", time: "0:05" },
					{ speaker: "Patient", name: "Maria", text: "hello", time: "0:09" },
					{ speaker: "Patient", name: "Maria", text: "again" },
					{ name: "Browser voice", text: "note" },
				],
				opts,
			);
			expect(turns).toHaveLength(3);
			expect(turns[0]).toMatchObject({ speaker: 0, name: "Dr. House", role: "Doctor" });
			expect(turns[0]!.paragraphs).toHaveLength(2);
			expect(turns[1]).toMatchObject({ speaker: 1, name: "Maria", role: "Patient" });
			expect(turns[2]).toMatchObject({ speaker: 2, name: "Browser voice" });
			expect(turns[2]!.role).toBeUndefined();
		});

		it("does not merge non-consecutive rows from the same channel", () => {
			const turns = liveConsultationTurns(
				[
					{ speaker: "Doctor", name: "Doctor", text: "a" },
					{ speaker: "Patient", name: "P", text: "b" },
					{ speaker: "Doctor", name: "Doctor", text: "c" },
				],
				opts,
			);
			expect(turns).toHaveLength(3);
		});

		it("falls back to the channel prefix without a physician name", () => {
			const turns = liveConsultationTurns([{ speaker: "Doctor", name: "Doctor", text: "x" }], {
				doctor: "Doctor",
				patient: "Patient",
			});
			expect(turns[0]!.name).toBe("Doctor");
		});
	});
});

describe("ZK encrypted audio upload (T-147)", () => {
	const zk = { keyring: { tag: "k" }, api: { tag: "a" } } as never;
	const audioBlob = new Blob(["audio"], { type: "audio/webm" });

	beforeEach(() => {
		micSupported = true;
		micCb = null;
		tabCb = null;
		micStatsFn = null;
		micRecFn = null;
		tabStatsFn = null;
		tabRecFn = null;
		statusImpl = () => ({ state: "idle", device: null });
		engineSubs.clear();
		// jsdom lacks dialog.showModal
		HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		});
		HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
			this.removeAttribute("open");
		});
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	const audioInit = (fetchMock: ReturnType<typeof vi.fn>) =>
		fetchMock.mock.calls.find((c) => String(c[0]).includes("/audio"))?.[1] as RequestInit;

	it("uploads framed ciphertext, never the plaintext recording", async () => {
		zkMocks.extractAnamnesisZk.mockResolvedValue({ anamnesis: ANAMNESIS, engine: "heuristic" });
		const user = userEvent.setup();
		tabRecFn = async () => audioBlob;
		const api = makeApi();
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ ok: true, audioStatus: "zk" }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		render(
			<NewConsultationPage
				initialPatients={PATIENTS}
				api={api}
				backend={backend}
				zk={zk}
				liveFlow={false}
			/>,
		);
		await consent(user);
		await generateAnamnesis(user);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText("Anamnesis saved successfully");
		await waitFor(() => expect(audioInit(fetchMock)).toBeTruthy());
		expect(zkMocks.consultationDek).toHaveBeenCalledWith({ tag: "k" }, { tag: "a" }, 42);
		expect(streamMocks.encryptToBlob).toHaveBeenCalledWith({ tag: "dek" }, expect.any(Uint8Array));
		const init = audioInit(fetchMock);
		expect(init.headers).toEqual({ "content-type": "application/octet-stream" });
		// The body is the framed ciphertext — the raw webm bytes never
		// leave the device.
		expect((init.body as Blob).size).toBe(1);
	});

	it("fails closed — locked record means no upload at all", async () => {
		zkMocks.extractAnamnesisZk.mockResolvedValue({ anamnesis: ANAMNESIS, engine: "heuristic" });
		const user = userEvent.setup();
		tabRecFn = async () => audioBlob;
		const api = makeApi();
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
		vi.stubGlobal("fetch", fetchMock);
		render(
			<NewConsultationPage
				initialPatients={PATIENTS}
				api={api}
				backend={backend}
				zk={zk}
				liveFlow={false}
			/>,
		);
		await consent(user);
		await generateAnamnesis(user);
		zkMocks.consultationDek.mockResolvedValueOnce(null);
		await user.click(screen.getByText("Save consultation"));
		await screen.findByText(/could not be uploaded/i);
		expect(audioInit(fetchMock)).toBeUndefined();
		expect(streamMocks.encryptToBlob).not.toHaveBeenCalled();
	});
});
// T-148: ZK saves wrap the record DEK to the portal devices of the
// linked patient's active links, on top of the clinic-device grants.
describe("NewConsultationPage ZK portal grants", () => {
	beforeEach(() => {
		// Recorder hooks are module-level mock state — without this reset a
		// `recording()` left over from the T-147 describe makes every save
		// here fire the fire-and-forget uploadSessionAudio, whose late
		// setToast can land after the jsdom teardown (unhandled rejection).
		micSupported = true;
		micCb = null;
		tabCb = null;
		micStatsFn = null;
		micRecFn = null;
		tabStatsFn = null;
		tabRecFn = null;
		statusImpl = () => ({ state: "idle", device: null });
		engineSubs.clear();
		// The portal-grant tests exercise the real local extraction seam —
		// the deterministic heuristic produces the "media" confidence
		// labels these flows assert on.
		zkMocks.extractAnamnesisZk.mockImplementation(zkMocks.originals.extractAnamnesisZk as never);
		// The portal wrap path needs real CryptoKeys — the hoisted fake
		// `{tag:"dek"}` placeholders would fail closed to zero grants.
		const realDek = async () => {
			const keyring = makeKeyring({ store: memoryStore() });
			const { wrapPublicKey } = await keyring.deviceKeys();
			const { dek } = await keyring.mintDek(wrapPublicKey);
			return dek;
		};
		zkMocks.newConsultationDek.mockImplementation(async () => ({
			dek: (await realDek()) as never,
			grants: [{ readerKind: "device" as const, readerPubkey: "w", wrappedDek: "w1.g" }],
		}));
		zkMocks.consultationDek.mockImplementation(realDek);
		// jsdom lacks dialog.showModal — the save-ok dialog mounts open.
		HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		});
		HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
			this.removeAttribute("open");
		});
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});
	const portalDevice = makeKeyring({ store: memoryStore() });
	// Under ZK extraction is local (heuristic) — its confidence labels
	// differ from the api.extractAnamnesis fixture.
	const generateZk = async (user: ReturnType<typeof userEvent.setup>) => {
		await fillTranscript();
		await user.click(screen.getByText("Generate anamnesis →"));
		await screen.findByText("medium confidence");
	};
	const makeZk = (envelopes: Record<string, string> = {}) => {
		const keyring = makeKeyring({ store: memoryStore() });
		return {
			keyring,
			api: {
				devices: vi.fn(async () => []),
				dekEnvelopes: vi.fn(
					async (_input: {
						entityType: string;
						entityIds: readonly (number | string)[];
						wrapPublicKey: string;
					}): Promise<Record<string, string>> => envelopes,
				),
				grant: vi.fn(async () => ({ ok: true })),
			},
		};
	};

	it("grants the record + patient DEKs to registered portal readers", async () => {
		const user = userEvent.setup();
		const portalPub = (await portalDevice.deviceKeys()).wrapPublicKey;
		const zk = makeZk();
		// This device can unwrap the patient DEK — as if it were granted.
		const { wrapPublicKey } = await zk.keyring.deviceKeys();
		const { envelope } = await zk.keyring.mintDek(wrapPublicKey);
		zk.api.dekEnvelopes = vi.fn(
			async (input: { entityIds: readonly (number | string)[] }): Promise<Record<string, string>> =>
				String(input.entityIds[0]) === "1" ? { "1": envelope } : {},
		);
		const api = makeApi({
			portalReaders: vi.fn(async () => ({
				readers: [{ readerId: "ana", wrapPublicKey: portalPub }],
			})),
		});
		renderPage(api, PATIENTS, 1, zk);
		await generateZk(user);
		await user.click(screen.getByText("Save consultation"));
		// The dialog string is statically mounted — wait on the call itself.
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		expect(api["portalReaders"]).toHaveBeenCalledWith({ data: 1 });
		// The patient DEK went through grantAccess (readerKind patient),
		// and the consultation grant rode the create payload.
		expect(zk.api.grant).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "patient", entityId: 1 }),
		);
		const payload = (api["saveConsultation"] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
			data: { grants: { readerKind: string; readerPubkey: string }[] };
		};
		expect(
			payload.data.grants.some((g) => g.readerKind === "patient" && g.readerPubkey === portalPub),
		).toBe(true);
	});

	it("attaches portal grants on the update path too", async () => {
		const user = userEvent.setup();
		const portalPub = (await portalDevice.deviceKeys()).wrapPublicKey;
		const zk = makeZk();
		// This device can unwrap both the patient DEK (1) and the saved
		// consultation's DEK (42) — the update path needs the latter.
		const { wrapPublicKey } = await zk.keyring.deviceKeys();
		const { envelope } = await zk.keyring.mintDek(wrapPublicKey);
		zk.api.dekEnvelopes = vi.fn(
			async (input: {
				entityIds: readonly (number | string)[];
			}): Promise<Record<string, string>> => ({
				[String(input.entityIds[0])]: envelope,
			}),
		);
		const api = makeApi({
			portalReaders: vi.fn(async () => ({
				readers: [{ readerId: "ana", wrapPublicKey: portalPub }],
			})),
		});
		renderPage(api, PATIENTS, 1, zk);
		await generateZk(user);
		// The first save creates the record (savedId) — under ZK there is
		// no bot path, so a second save is what exercises attachAnamnesis.
		await user.click(screen.getByText("Save consultation"));
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		await user.click(await screen.findByText(/Not now|Confirm/));
		await user.click(await screen.findByText("Update consultation"));
		await waitFor(() => expect(api["attachAnamnesis"]).toHaveBeenCalled());
		const payload = (api["attachAnamnesis"] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
			data: { grants: { readerKind: string }[] };
		};
		expect(payload.data.grants.some((g) => g.readerKind === "patient")).toBe(true);
	});

	it("still shares the record DEK when this device has no patient-DEK envelope", async () => {
		const user = userEvent.setup();
		const portalPub = (await portalDevice.deviceKeys()).wrapPublicKey;
		// makeZk() defaults dekEnvelopes to {} — patientDek resolves null,
		// so the patient-entity grant is skipped but the record grant
		// still rides the create payload.
		const zk = makeZk();
		const api = makeApi({
			portalReaders: vi.fn(async () => ({
				readers: [{ readerId: "ana", wrapPublicKey: portalPub }],
			})),
		});
		renderPage(api, PATIENTS, 1, zk);
		await generateZk(user);
		await user.click(screen.getByText("Save consultation"));
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		expect(zk.api.grant).not.toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "patient" }),
		);
		const payload = (api["saveConsultation"] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
			data: { grants: { readerKind: string; readerPubkey: string }[] };
		};
		expect(
			payload.data.grants.some((g) => g.readerKind === "patient" && g.readerPubkey === portalPub),
		).toBe(true);
	});

	it("saves normally when the reader lookup fails or is absent", async () => {
		const user = userEvent.setup();
		const zk = makeZk();
		const api = makeApi({
			portalReaders: vi.fn(async () => {
				throw new Error("down");
			}),
		});
		renderPage(api, PATIENTS, 1, zk);
		await generateZk(user);
		await user.click(screen.getByText("Save consultation"));
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		const payload = (api["saveConsultation"] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
			data: { grants: unknown[] };
		};
		expect(
			payload.data.grants.every((g) => (g as { readerKind: string }).readerKind !== "patient"),
		).toBe(true);
	});

	it("skips the portal pass when the api lacks it", async () => {
		const user = userEvent.setup();
		const api = makeApi(); // no portalReaders
		renderPage(api, PATIENTS, 1, makeZk());
		await generateZk(user);
		await user.click(screen.getByText("Save consultation"));
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
	});

	it("skips the portal pass when no patient is linked", async () => {
		const user = userEvent.setup();
		const api = makeApi({
			portalReaders: vi.fn(async () => null),
		});
		renderPage(api, PATIENTS, undefined, makeZk());
		await generateZk(user);
		await user.click(screen.getByText("Save consultation"));
		await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		expect(api["portalReaders"]).not.toHaveBeenCalled();
	});

	it("skips the portal pass for a null plan or one with no readers", async () => {
		for (const plan of [null, { readers: [] }]) {
			cleanup();
			const user = userEvent.setup();
			const api = makeApi({ portalReaders: vi.fn(async () => plan) });
			renderPage(api, PATIENTS, 1, makeZk());
			await generateZk(user);
			await user.click(screen.getByText("Save consultation"));
			await waitFor(() => expect(api["saveConsultation"]).toHaveBeenCalled());
		}
	});
});

describe("lazy ASR engine load", () => {
	// This describe sits outside "NewConsultationPage" — its afterEach
	// cleanup does not apply here.
	afterEach(cleanup);
	beforeEach(() => backendLoad.mockClear());
	const loadMock = () => backendLoad;

	it("does not load the engine on mount — the paste/sample path stays light", () => {
		renderPage();
		expect(loadMock()).not.toHaveBeenCalled();
	});

	it("does not load for the sample, upload or bot sources", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Use sample"));
		await user.click(screen.getByText("Upload"));
		await user.click(screen.getByText("Teleconsult (bot)"));
		expect(loadMock()).not.toHaveBeenCalled();
	});

	it("loads the engine when mic recording starts", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		expect(loadMock()).toHaveBeenCalled();
	});

	it("loads the engine when tab capture starts", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		expect(loadMock()).toHaveBeenCalled();
	});

	it("loads the engine when dictation starts", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Post-consultation dictation"));
		await user.click(screen.getByText("Start dictation"));
		expect(loadMock()).toHaveBeenCalled();
	});
});

describe("NewConsultationPage — chat workspace actions", () => {
	const transcriptBox = () => screen.getByLabelText("Consultation text") as HTMLTextAreaElement;

	beforeEach(() => {
		micSupported = true;
		micCb = null;
		tabCb = null;
		micStatsFn = null;
		micRecFn = null;
		tabStatsFn = null;
		tabRecFn = null;
		statusImpl = () => ({ state: "idle", device: null });
		engineSubs.clear();
		draftMock.state.draft = null;
		draftMock.store.load.mockClear();
		draftMock.store.save.mockClear();
		draftMock.store.clear.mockClear();
		vi.stubGlobal("fetch", vi.fn());
		HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		});
		HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
			this.removeAttribute("open");
		});
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("stop capture ends every running channel at once", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		await user.click(screen.getByText("Capture call tab"));
		await user.click(screen.getByRole("button", { name: "Stop capture" }));
		expect(micStop).toHaveBeenCalled();
		expect(tabStop).toHaveBeenCalled();
	});

	it("a second channel joining keeps the capture clock running", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		await user.click(screen.getByText("Record microphone"));
		await user.click(screen.getByRole("button", { name: "Stop capture" }));
		expect(micStop).toHaveBeenCalled();
		expect(tabStop).toHaveBeenCalled();
	});

	it("stop capture with only the tab channel leaves the mic alone", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Capture call tab"));
		await user.click(screen.getByRole("button", { name: "Stop capture" }));
		expect(tabStop).toHaveBeenCalled();
		expect(micStop).not.toHaveBeenCalled();
	});

	it("stop capture ends dictation too", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Post-consultation dictation"));
		await consent(user);
		await user.click(screen.getByText("Start dictation"));
		await user.click(screen.getByRole("button", { name: "Stop capture" }));
		expect(micStop).toHaveBeenCalled();
	});

	it("copies the transcript to the clipboard", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderPage();
		fillTranscript("linha um\nlinha dois");
		await user.click(screen.getByText("Copy transcript"));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("linha um\nlinha dois"));
		await screen.findByText(/Transcript copied/);
	});

	it("a failed transcript copy surfaces the error", async () => {
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
			configurable: true,
		});
		renderPage();
		fillTranscript("texto");
		await user.click(screen.getByText("Copy transcript"));
		await screen.findByText(/Could not copy/);
	});

	it("downloads the transcript as a text file", async () => {
		const user = userEvent.setup();
		const create = vi.fn(() => "blob:export");
		const revoke = vi.fn();
		Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true });
		Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
		renderPage();
		fillTranscript("export me");
		await user.click(screen.getByText(/Download transcript/));
		expect(create).toHaveBeenCalled();
		expect(revoke).toHaveBeenCalledWith("blob:export");
	});

	it("trims captured row timestamps when the transcript shrinks", async () => {
		const user = userEvent.setup();
		renderPage();
		await consent(user);
		await user.click(screen.getByText("Record microphone"));
		act(() => micCb!({ type: "final", text: "primeira" }));
		act(() => micCb!({ type: "final", text: "segunda" }));
		await waitFor(() => expect(transcriptBox().value).toContain("segunda"));
		fireEvent.change(transcriptBox(), { target: { value: "só uma linha" } });
		expect(transcriptBox().value).toBe("só uma linha");
	});

	it("attributes Patient lines to the selected patient name", () => {
		renderPage(makeApi(), PATIENTS, 1);
		fillTranscript("Patient: oi doutor\nlinha solta");
		expect(screen.getAllByText("Maria").length).toBeGreaterThan(0);
	});
});
