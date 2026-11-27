// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const zkMocks = vi.hoisted(() => ({
	decryptConsultation: vi.fn(async () => null as unknown),
	decryptConsultations: vi.fn(async () => [] as unknown[]),
	consultationDek: vi.fn(async (): Promise<unknown> => ({ tag: "dek" })),
}));
vi.mock("../zk.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../zk.ts")>()),
	...zkMocks,
}));

const streamMocks = vi.hoisted(() => ({
	decryptBlob: vi.fn(async () => new Uint8Array([7, 8, 9])),
}));
vi.mock("@ktb/crypto/stream", () => streamMocks);

const routerMocks = vi.hoisted(() => ({ navigate: vi.fn(), invalidate: vi.fn() }));
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
import { ConsultationDetailPage } from "./ConsultationDetailPage.tsx";
import { serializeTranscriptEdits } from "../transcript-edits.ts";
import { bytesToB64, genesisUpdate } from "../transcript-projection.ts";

const SECTION = { content: "", confidence: "baixa" as const, evidence: [] as string[] };
const ANAMNESIS = {
	queixa_principal: { content: "Dor", confidence: "alta" as const, evidence: ["dor relatada"] },
	hda: { content: "A preencher pelo médico: hda.", confidence: "media" as const, evidence: [] },
	antecedentes: SECTION,
	alergias: SECTION,
	medicamentos_em_uso: SECTION,
	exame_fisico: SECTION,
	hipoteses: SECTION,
	conduta: { content: "", confidence: "baixa" as const, evidence: [] },
};

const BASE: ConsultationDetail = {
	id: 10,
	userId: "u1",
	patientId: 1,
	botId: null,
	createdAt: new Date("2026-11-06T14:30:00"),
	transcript: "Médico: oi\nPaciente: olá doutor",
	source: "browser",
	status: "done",
	engine: "heuristic",
	consentAt: new Date("2026-11-06T14:00:00"),
	patientName: "Maria",
	anamnesis: ANAMNESIS,
	audioKey: null,
	audioStatus: "none",
	audioError: null,
	serverTranscript: null,
	correctedTranscript: null,
	enhancementEngine: null,
};

const detail = (over: Partial<ConsultationDetail>): ConsultationDetail => ({ ...BASE, ...over });

afterEach(cleanup);

describe("ConsultationDetailPage", () => {
	it("renders full detail with anamnesis and transcript", () => {
		render(<ConsultationDetailPage c={detail({})} history={null} />);
		// Name shows in the page heading and the patient context bar.
		expect(screen.getAllByText("Maria").length).toBeGreaterThan(0);
		expect(screen.getByText(/Consultation #10/)).toBeTruthy();
		expect(screen.getByText(/engine: heuristic/)).toBeTruthy();
		expect(screen.getByText(/Consent ✓/)).toBeTruthy();
		expect(screen.getByText("Browser voice")).toBeTruthy();
		expect(screen.getByText("Dor")).toBeTruthy();
		expect(screen.getByText(/evidence \(1\)/)).toBeTruthy();
		expect(screen.getByText("olá doutor")).toBeTruthy();
		expect(screen.queryByText("Segunda opinião")).toBeNull();
	});

	it("lays out the record with design-system slots", () => {
		const { container } = render(<ConsultationDetailPage c={detail({})} history={null} />);
		expect(container.querySelector('[data-slot="page-container"]')).not.toBeNull();
		expect(container.querySelector('[data-slot="page-header"]')).not.toBeNull();
		// Transcript chat + anamnesis column cards; the status chips the
		// old "Details" card carried now live in the patient context bar.
		expect(screen.getByText("Browser voice")).toBeTruthy();
		expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThanOrEqual(2);
		// The transcript body scrolls inside a ScrollArea viewport.
		expect(container.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeNull();
	});

	it("links the patient name to the patient record", () => {
		render(<ConsultationDetailPage c={detail({})} history={null} />);
		const link = screen.getByTitle("Open patient record");
		expect(link.textContent).toBe("Maria");
		expect(link.getAttribute("href")).toBe("/patients/1");
	});

	it("prefixes internal links with portalBase", () => {
		const { container } = render(
			<ConsultationDetailPage c={detail({})} history={null} portalBase="/portal" />,
		);
		expect(screen.getByTitle("Open patient record").getAttribute("href")).toBe(
			"/portal/patients/1",
		);
		expect(container.querySelector('a[href="/portal/consultations"]')).not.toBeNull();
	});

	it("shows an unlinked patient name as plain text", () => {
		render(<ConsultationDetailPage c={detail({ patientId: null })} history={null} />);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Maria");
		expect(screen.queryByTitle("Open patient record")).toBeNull();
	});

	it("renders minimal detail: no anamnesis/patient/consent", () => {
		render(
			<ConsultationDetailPage
				history={null}
				c={detail({
					patientName: null,
					anamnesis: null,
					consentAt: null,
					engine: null,
					source: null,
					status: "live",
				})}
			/>,
		);
		expect(screen.getByText("Consultation #10")).toBeTruthy();
		expect(screen.getByText("Consent not recorded")).toBeTruthy();
		expect(screen.getByText("in progress")).toBeTruthy();
		expect(screen.getByText(/does not have a saved anamnesis/)).toBeTruthy();
		expect(screen.getByText("olá doutor")).toBeTruthy();
	});

	it("renders the locked export control on ZK records (T-146)", async () => {
		// Plaintext test row passes the ZK decrypt path straight through
		// (no envelopes → no keyring calls); the export affordance is a
		// gated disabled control, not a hidden link.
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				zk={{ keyring: {} as never, api: {} as never }}
			/>,
		);
		const locked = await screen.findByRole("button", {
			name: "PDF export unavailable for encrypted records",
		});
		expect((locked as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole("link", { name: /PDF/i })).toBeNull();
	});

	it("shows empty transcript message", () => {
		render(<ConsultationDetailPage c={detail({ transcript: "  \n " })} history={null} />);
		expect(screen.getByText("No transcript.")).toBeTruthy();
	});

	it("copies anamnesis to clipboard", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		render(<ConsultationDetailPage c={detail({})} history={null} />);
		await user.click(screen.getByText("Copy"));
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		await screen.findByText("Anamnesis copied");
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText("Anamnesis copied")).toBeNull());
	});

	it("copy without anamnesis is a no-op (button hidden)", () => {
		render(<ConsultationDetailPage c={detail({ anamnesis: null })} history={null} />);
		expect(screen.queryByText("Copy")).toBeNull();
		expect(screen.queryByText("Download PDF")).toBeNull();
	});

	it("renders pending section styling and dash for empty content", () => {
		render(<ConsultationDetailPage c={detail({})} history={null} />);
		expect(screen.getByText(/A preencher pelo médico/)).toBeTruthy();
	});

	it("tolerates anamnesis missing section keys", () => {
		const partial = { queixa_principal: SECTION } as unknown as Anamnesis;
		render(<ConsultationDetailPage c={detail({ anamnesis: partial })} history={null} />);
		expect(screen.getByText("Chief complaint")).toBeTruthy();
	});

	it("shows previous-consultations badge and collapsed history", () => {
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={{
					count: 2,
					visits: [
						{
							id: 8,
							date: "2026-03-05T14:30:00.000Z",
							chiefComplaint: "Dor de cabeça",
							plan: "Dipirona",
						},
						{ id: 7, date: "2026-01-20T10:00:00.000Z", chiefComplaint: null, plan: null },
					],
				}}
			/>,
		);
		expect(screen.getByText("2 previous consultations")).toBeTruthy();
		expect(screen.getByText(/Prior consultations · 2 previous consultations/)).toBeTruthy();
		expect(screen.getByText("Complaint: Dor de cabeça")).toBeTruthy();
		expect(screen.getByText("Plan: Dipirona")).toBeTruthy();
		expect(screen.getByText(/consultation #8/)).toBeTruthy();
		expect(screen.getByText(/not clinical suggestions/)).toBeTruthy();
	});

	it("singularizes the badge for a single previous consultation", () => {
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={{
					count: 1,
					visits: [
						{
							id: 8,
							date: "2026-03-05T14:30:00.000Z",
							chiefComplaint: "Febre",
							plan: null,
						},
					],
				}}
			/>,
		);
		expect(screen.getByText("1 previous consultation")).toBeTruthy();
		expect(screen.getByText("Complaint: Febre")).toBeTruthy();
	});

	describe("ZK decryption (T-145)", () => {
		const zk = { keyring: { tag: "k" }, api: { tag: "a" } } as never;

		it("renders the locked state when the consultation has no grant", async () => {
			zkMocks.decryptConsultation.mockResolvedValueOnce(null);
			render(
				<ConsultationDetailPage c={detail({ anamnesisRaw: "v1.aa.bb" })} history={null} zk={zk} />,
			);
			expect(await screen.findByText("Encrypted record")).toBeTruthy();
			expect(screen.getByText("Unlock it on an approved clinic device to view it.")).toBeTruthy();
			expect(zkMocks.decryptConsultation).toHaveBeenCalledWith(
				{ tag: "k" },
				{ tag: "a" },
				expect.objectContaining({ anamnesis: "v1.aa.bb" }),
			);
		});

		it("locks the record when decryption throws", async () => {
			zkMocks.decryptConsultation.mockRejectedValueOnce(new Error("no grant"));
			render(<ConsultationDetailPage c={detail({})} history={null} zk={zk} />);
			expect(await screen.findByText("Encrypted record")).toBeTruthy();
		});

		it("overlays decrypted fields and builds the history client-side", async () => {
			zkMocks.decryptConsultation.mockResolvedValueOnce({
				anamnesis: JSON.stringify(ANAMNESIS),
				transcript: "decrypted transcript body",
				patientName: "Maria Dec",
				serverTranscript: "v1.st.env",
				correctedTranscript: null,
			});
			zkMocks.decryptConsultations.mockResolvedValueOnce([
				{
					id: 3,
					anamnesis: JSON.stringify({
						...ANAMNESIS,
						conduta: { content: "Dipirona", confidence: "alta", evidence: [] },
					}),
					createdAt: new Date("2026-01-01"),
				},
			]);
			render(
				<ConsultationDetailPage
					c={detail({ anamnesisRaw: "v1.aa.bb" })}
					history={null}
					historyRows={{
						count: 1,
						rows: [{ id: 3, anamnesis: "v1.hist.env", createdAt: new Date() }],
					}}
					zk={zk}
				/>,
			);
			expect((await screen.findAllByText("Maria Dec")).length).toBeGreaterThan(0);
			expect(await screen.findByText("decrypted transcript body")).toBeTruthy();
			expect(await screen.findByText("Complaint: Dor")).toBeTruthy();
			expect(await screen.findByText("Plan: Dipirona")).toBeTruthy();
		});

		it("falls back to the server anamnesis when the decrypted payload is corrupt", async () => {
			zkMocks.decryptConsultation.mockResolvedValueOnce({
				anamnesis: "v1.corrupt",
				transcript: "plain",
				patientName: "Maria",
				serverTranscript: null,
				correctedTranscript: null,
			});
			render(<ConsultationDetailPage c={detail({})} history={null} zk={zk} />);
			expect(await screen.findByText("Dor")).toBeTruthy();
		});

		it("keeps the page usable when history decryption fails", async () => {
			zkMocks.decryptConsultation.mockResolvedValueOnce({
				anamnesis: JSON.stringify(ANAMNESIS),
				transcript: "plain",
				patientName: "Maria",
				serverTranscript: null,
				correctedTranscript: null,
			});
			zkMocks.decryptConsultations.mockRejectedValueOnce(new Error("no hist"));
			render(
				<ConsultationDetailPage
					c={detail({})}
					history={null}
					historyRows={{
						count: 1,
						rows: [{ id: 3, anamnesis: "v1.h", createdAt: new Date() }],
					}}
					zk={zk}
				/>,
			);
			expect((await screen.findAllByText("Maria")).length).toBeGreaterThan(0);
		});

		it("ignores late decrypt resolutions and rejections after unmount", async () => {
			let resolveRow: (v: unknown) => void = () => {};
			let resolveHist: (v: unknown[]) => void = () => {};
			let resolveIntegrity: (v: unknown) => void = () => {};
			let rejectRow: (e: unknown) => void = () => {};
			zkMocks.decryptConsultation
				.mockImplementationOnce(
					() =>
						new Promise((r) => {
							resolveRow = r;
						}),
				)
				.mockImplementationOnce(
					() =>
						new Promise((_r, rej) => {
							rejectRow = rej;
						}),
				);
			zkMocks.decryptConsultations.mockImplementationOnce(
				() =>
					new Promise<unknown[]>((r) => {
						resolveHist = r;
					}),
			);
			const api = {
				getConsultation: vi.fn(async () => null),
				verifyIntegrity: vi.fn(
					() =>
						new Promise<unknown>((r) => {
							resolveIntegrity = r;
						}),
				),
			} as never;
			const first = render(
				<ConsultationDetailPage
					c={detail({})}
					history={null}
					historyRows={{
						count: 1,
						rows: [{ id: 3, anamnesis: "v1.h", createdAt: new Date() }],
					}}
					api={api}
					zk={zk}
				/>,
			);
			first.unmount();
			await act(async () => {
				resolveRow(null);
				resolveHist([]);
				resolveIntegrity(null);
			});
			const second = render(<ConsultationDetailPage c={detail({})} history={null} zk={zk} />);
			second.unmount();
			await act(async () => {
				rejectRow(new Error("late"));
			});
		});
	});

	it("hides history UI when count is zero", () => {
		render(<ConsultationDetailPage c={detail({})} history={{ count: 0, visits: [] }} />);
		expect(screen.queryByText(/previous consultation/)).toBeNull();
	});

	it("shows corrected/original tabs, status chip and audio player", () => {
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "audio/u1/10/x.webm",
					audioStatus: "done",
					serverTranscript: "Médico: oi\nPaciente: olá",
					correctedTranscript: "Médico: Olá.\nPaciente: Olá, doutor.",
				})}
				history={null}
			/>,
		);
		// corrected is the default tab
		expect(screen.getByText("Olá, doutor.")).toBeTruthy();
		expect(screen.getByText("Corrected")).toBeTruthy();
		expect(screen.getByText("Original")).toBeTruthy();
		expect(screen.getByText("enhanced ✓")).toBeTruthy();
		const audio = document.querySelector("audio") as HTMLAudioElement;
		expect(audio.src).toContain("/api/consultations/10/audio");
	});

	it("original tab shows labeled server and browser transcripts", async () => {
		const user = userEvent.setup();
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k",
					audioStatus: "done",
					serverTranscript: "server raw text",
					correctedTranscript: "clean corrected",
				})}
				history={null}
			/>,
		);
		await user.click(screen.getByText("Original"));
		expect(screen.getByText("server raw text")).toBeTruthy();
		expect(screen.getByText("server · whisper large-v3-turbo")).toBeTruthy();
		// browser transcript differs → shown as a second labeled block
		expect(screen.getByText("browser")).toBeTruthy();
		expect(screen.getByText("olá doutor")).toBeTruthy();
		await user.click(screen.getByText("Corrected"));
		expect(screen.getByText("clean corrected")).toBeTruthy();
		expect(screen.getByText("llm corrected")).toBeTruthy();
	});

	it("hides tabs when there is no corrected transcript and shows raw originals", () => {
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k",
					audioStatus: "done",
					serverTranscript: "server raw text",
				})}
				history={null}
			/>,
		);
		expect(screen.queryByText("Corrected")).toBeNull();
		expect(screen.getByText("server raw text")).toBeTruthy();
		expect(screen.getByText("browser")).toBeTruthy();
	});

	it("shows enhancing and failed status chips", () => {
		const { unmount } = render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "processing" })}
				history={null}
			/>,
		);
		// The status shows both as a context-bar chip and a panel badge.
		expect(screen.getAllByText(/enhancing transcript/).length).toBeGreaterThan(0);
		unmount();
		render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "failed" })}
				history={null}
			/>,
		);
		expect(screen.getByText(/enhancement failed — showing original/)).toBeTruthy();
	});

	it("polls getConsultation while the pipeline is in flight", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const api = {
			getConsultation: vi
				.fn()
				.mockResolvedValueOnce({
					audioStatus: "processing",
					audioKey: "k",
					serverTranscript: null,
					correctedTranscript: null,
				})
				.mockResolvedValue({
					audioStatus: "done",
					audioKey: "k",
					serverTranscript: "server raw",
					correctedTranscript: "clean corrected",
				}),
		};
		render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "queued" })}
				history={null}
				api={api}
			/>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(api.getConsultation).toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3100);
		});
		await screen.findByText("clean corrected");
		expect(screen.getByText("enhanced ✓")).toBeTruthy();
		vi.useRealTimers();
	});

	it("shows the integrity badge once verification resolves", async () => {
		const verifyIntegrity = vi.fn(async () => ({
			status: "verified" as const,
			versions: 2,
			unverifiableContent: 0,
			signed: 0,
			issues: [],
			head: { version: 2, contentHash: "ab".repeat(32) },
			storedVersion: 2,
		}));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), verifyIntegrity }}
			/>,
		);
		expect(verifyIntegrity).toHaveBeenCalledWith({ data: 10 });
		expect(await screen.findByText("Integrity verified")).toBeTruthy();
	});

	it("surfaces a tampered chain and never blocks rendering on a failed check", async () => {
		const tampered = vi.fn(async () => ({
			status: "tampered" as const,
			versions: 2,
			unverifiableContent: 0,
			signed: 0,
			issues: [{ version: 2, code: "chain-broken" as const }],
			head: { version: 2, contentHash: "ab".repeat(32) },
			storedVersion: 2,
		}));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), verifyIntegrity: tampered }}
			/>,
		);
		expect(await screen.findByText("Integrity check failed")).toBeTruthy();

		cleanup();
		const rejected = vi.fn(async () => {
			throw new Error("fn down");
		});
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), verifyIntegrity: rejected }}
			/>,
		);
		// Rejected verification leaves no badge — the page still renders.
		await act(async () => {});
		expect(screen.queryByText("Integrity verified")).toBeNull();
		expect(screen.queryByText("Integrity check failed")).toBeNull();
		expect(screen.getAllByText("Maria").length).toBeGreaterThan(0);
	});

	it("renders transcript lines without speaker prefix and unknown speakers", () => {
		render(
			<ConsultationDetailPage
				history={null}
				c={detail({
					transcript: "linha solta\nEnfermeiro Chefe: preparado?\nMédico: sim",
				})}
			/>,
		);
		expect(screen.getByText("linha solta")).toBeTruthy();
		expect(screen.getByText("Enfermeiro Chefe")).toBeTruthy();
		expect(screen.getByText("Médico")).toBeTruthy();
	});

	describe("clickable transcript evidence", () => {
		it("toggles marks in the transcript and scrolls to the first match", async () => {
			const user = userEvent.setup();
			const scrollSpy = vi.fn<() => void>();
			Element.prototype.scrollIntoView = scrollSpy;
			render(
				<ConsultationDetailPage
					history={null}
					c={detail({ transcript: "Médico: oi\nPaciente: sinto DOR RELATADA há dias" })}
				/>,
			);
			expect(document.querySelector("mark")).toBeNull();
			const toggle = screen.getByRole("button", { name: "Show evidence" });
			expect(toggle.getAttribute("aria-pressed")).toBe("false");
			await user.click(toggle);
			// Case-insensitive match: original casing renders inside <mark>.
			const marks = document.querySelectorAll("mark");
			expect(marks.length).toBe(1);
			expect(marks[0]?.textContent).toBe("DOR RELATADA");
			expect(toggle.getAttribute("aria-pressed")).toBe("true");
			expect(toggle.textContent).toContain("Hide evidence");
			expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
			delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		});

		it("switches the highlight when another section's toggle is pressed", async () => {
			const user = userEvent.setup();
			const anamnesis = {
				...ANAMNESIS,
				queixa_principal: {
					content: "Dor",
					confidence: "alta" as const,
					evidence: ["dor relatada"],
				},
				conduta: {
					content: "Repouso",
					confidence: "media" as const,
					evidence: ["receitar repouso"],
				},
			};
			render(
				<ConsultationDetailPage
					history={null}
					c={detail({
						anamnesis,
						transcript: "Paciente: sinto dor relatada\nMédico: vou receitar repouso",
					})}
				/>,
			);
			const [first] = screen.getAllByRole("button", { name: "Show evidence" });
			await user.click(first);
			expect(document.querySelector("mark")?.textContent).toBe("dor relatada");
			// The second toggle still reads "Show evidence"; pressing it
			// moves the single active highlight to its sentences.
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			const marks = document.querySelectorAll("mark");
			expect(marks.length).toBe(1);
			expect(marks[0]?.textContent).toBe("receitar repouso");
			expect(screen.queryByRole("button", { name: "Hide evidence" })).toBeTruthy();
		});

		it("restores the plain transcript when the active toggle is pressed again", async () => {
			const user = userEvent.setup();
			render(
				<ConsultationDetailPage
					history={null}
					c={detail({ transcript: "Paciente: sinto dor relatada" })}
				/>,
			);
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			expect(document.querySelectorAll("mark").length).toBe(1);
			await user.click(screen.getByRole("button", { name: "Hide evidence" }));
			expect(document.querySelector("mark")).toBeNull();
			expect(screen.getByText("sinto dor relatada")).toBeTruthy();
		});

		it("renders no toggle on sections without evidence", () => {
			render(<ConsultationDetailPage c={detail({})} history={null} />);
			// Only queixa_principal carries evidence in the fixture.
			expect(screen.getAllByRole("button", { name: "Show evidence" }).length).toBe(1);
		});

		it("toggles state but renders no marks when evidence is absent from the transcript", async () => {
			const user = userEvent.setup();
			const scrollSpy = vi.fn<() => void>();
			Element.prototype.scrollIntoView = scrollSpy;
			render(<ConsultationDetailPage c={detail({})} history={null} />);
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			expect(
				screen.getByRole("button", { name: "Hide evidence" }).getAttribute("aria-pressed"),
			).toBe("true");
			expect(document.querySelector("mark")).toBeNull();
			expect(scrollSpy).not.toHaveBeenCalled();
			delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		});

		it("keeps the toggle working on an empty transcript", async () => {
			const user = userEvent.setup();
			render(<ConsultationDetailPage c={detail({ transcript: "   \n  " })} history={null} />);
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			expect(screen.getByText("No transcript.")).toBeTruthy();
			expect(document.querySelector("mark")).toBeNull();
		});

		it("escapes regex metachars and tolerates whitespace differences", async () => {
			const user = userEvent.setup();
			const anamnesis = {
				...ANAMNESIS,
				queixa_principal: {
					content: "Dor",
					confidence: "alta" as const,
					// "   " is ignored; the metachar-laden sentence still matches.
					evidence: ["   ", "dor (muito) forte + náusea?"],
				},
			};
			render(
				<ConsultationDetailPage
					history={null}
					c={detail({
						anamnesis,
						transcript: "Paciente: dor  (muito)   forte + náusea? desde ontem",
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			expect(document.querySelector("mark")?.textContent).toBe("dor  (muito)   forte + náusea?");
		});

		it("marks evidence in the decrypted transcript under ZK", async () => {
			const user = userEvent.setup();
			zkMocks.decryptConsultation.mockResolvedValueOnce({
				anamnesis: JSON.stringify(ANAMNESIS),
				transcript: "Paciente: sinto dor relatada",
				patientName: "Maria",
				serverTranscript: null,
				correctedTranscript: null,
			});
			render(
				<ConsultationDetailPage
					c={detail({ anamnesisRaw: "v1.aa.bb", transcript: "" })}
					history={null}
					zk={{ keyring: {} as never, api: {} as never }}
				/>,
			);
			await screen.findByText("sinto dor relatada");
			await user.click(screen.getByRole("button", { name: "Show evidence" }));
			expect(document.querySelector("mark")?.textContent).toBe("dor relatada");
		});
	});
});

describe("ZK audio playback (T-147)", () => {
	const zk = { keyring: { tag: "k" }, api: { tag: "a" } } as never;
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	const createUrl = vi.fn(() => "blob:zk-audio");
	const revokeUrl = vi.fn();
	beforeEach(() => {
		URL.createObjectURL = createUrl as never;
		URL.revokeObjectURL = revokeUrl as never;
	});
	afterEach(() => {
		URL.createObjectURL = origCreate as never;
		URL.revokeObjectURL = origRevoke as never;
		vi.unstubAllGlobals();
	});

	it("decrypts stored ciphertext into an object URL for the player", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "t",
			patientName: "Maria",
			anamnesis: null,
		});
		const fetchMock = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
		}));
		vi.stubGlobal("fetch", fetchMock);
		const { unmount } = render(
			<ConsultationDetailPage
				c={detail({ audioKey: "audio/u1/10/x.webm", audioStatus: "zk" })}
				history={null}
				zk={zk}
			/>,
		);
		await waitFor(() =>
			expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:zk-audio"),
		);
		expect(fetchMock).toHaveBeenCalledWith("/api/consultations/10/audio");
		expect(zkMocks.consultationDek).toHaveBeenCalledWith({ tag: "k" }, { tag: "a" }, 10);
		expect(streamMocks.decryptBlob).toHaveBeenCalledWith({ tag: "dek" }, expect.any(Uint8Array));
		expect(createUrl).toHaveBeenCalled();
		unmount();
		expect(revokeUrl).toHaveBeenCalledWith("blob:zk-audio");
	});

	it("renders no player when the record DEK is locked on this device", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "t",
			patientName: "Maria",
			anamnesis: null,
		});
		zkMocks.consultationDek.mockResolvedValueOnce(null);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(0),
		}));
		vi.stubGlobal("fetch", fetchMock);
		render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "zk" })}
				history={null}
				zk={zk}
			/>,
		);
		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(document.querySelector("audio")).toBeNull();
	});

	it("renders no player when the fetch fails", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "t",
			patientName: "Maria",
			anamnesis: null,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404 })),
		);
		render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "zk" })}
				history={null}
				zk={zk}
			/>,
		);
		await act(async () => {});
		expect(document.querySelector("audio")).toBeNull();
	});

	it("swallows decrypt failures and revokes the late URL after unmount", async () => {
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "t",
			patientName: "Maria",
			anamnesis: null,
		});
		let resolveDek: (d: unknown) => void = () => {};
		zkMocks.consultationDek.mockImplementationOnce(
			() =>
				new Promise<unknown>((r) => {
					resolveDek = r;
				}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })),
		);
		const { unmount } = render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "zk" })}
				history={null}
				zk={zk}
			/>,
		);
		unmount();
		resolveDek({ tag: "dek" });
		await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:zk-audio"));
		expect(document.querySelector("audio")).toBeNull();

		// A decryptBlob rejection is swallowed — no player, no crash.
		zkMocks.decryptConsultation.mockResolvedValueOnce({
			transcript: "t",
			patientName: "Maria",
			anamnesis: null,
		});
		streamMocks.decryptBlob.mockRejectedValueOnce(new Error("corrupt"));
		render(
			<ConsultationDetailPage
				c={detail({ audioKey: "k", audioStatus: "zk" })}
				history={null}
				zk={zk}
			/>,
		);
		await waitFor(() => expect(streamMocks.decryptBlob).toHaveBeenCalledTimes(2));
		expect(document.querySelector("audio")).toBeNull();
	});
});

describe("review stamps (PL-022)", () => {
	it("confirms the transcript and shows the stamp chip", async () => {
		const user = userEvent.setup();
		const reviewTranscript = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript }}
			/>,
		);
		await user.click(screen.getByText("Confirm transcript"));
		expect(reviewTranscript).toHaveBeenCalledWith({ data: 10 });
		expect(await screen.findByText(/Confirmed/)).toBeTruthy();
	});

	it("renders the transcript stamp instead of the button when already confirmed", () => {
		render(
			<ConsultationDetailPage
				c={detail({ transcriptReviewedAt: new Date("2026-11-06T15:00:00") })}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript: vi.fn() }}
			/>,
		);
		expect(screen.getByText(/Confirmed/)).toBeTruthy();
		expect(screen.queryByText("Confirm transcript")).toBeNull();
	});

	it("approves the anamnesis bound to the current version", async () => {
		const user = userEvent.setup();
		const approveAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesisVersion: 2 })}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Approve anamnesis"));
		expect(approveAnamnesis).toHaveBeenCalledWith({ data: 10 });
		expect(await screen.findByText("Approved v2")).toBeTruthy();
	});

	it("approve & next navigates to the next pending record", async () => {
		const user = userEvent.setup();
		const api = {
			getConsultation: vi.fn(),
			approveAnamnesis: vi.fn(async () => ({ ok: true })),
			nextPendingReview: vi.fn(async () => ({ id: 44 })),
		};
		render(<ConsultationDetailPage c={detail({ anamnesisVersion: 2 })} history={null} api={api} />);
		await user.click(screen.getByText("Approve & next"));
		expect(api.approveAnamnesis).toHaveBeenCalledWith({ data: 10 });
		expect(api.nextPendingReview).toHaveBeenCalledWith({ data: 10 });
		await waitFor(() =>
			expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/consultations/44" }),
		);
	});

	it("approve & next heads back to the list when the queue is done", async () => {
		const user = userEvent.setup();
		const api = {
			getConsultation: vi.fn(),
			approveAnamnesis: vi.fn(async () => ({ ok: true })),
			nextPendingReview: vi.fn(async () => ({ id: null })),
		};
		render(<ConsultationDetailPage c={detail({ anamnesisVersion: 2 })} history={null} api={api} />);
		await user.click(screen.getByText("Approve & next"));
		await waitFor(() =>
			expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/consultations" }),
		);
	});

	it("shows the stale-version chip when the anamnesis was edited after approval", () => {
		render(
			<ConsultationDetailPage
				c={detail({
					anamnesisVersion: 3,
					anamnesisReviewedAt: new Date("2026-11-06T15:00:00"),
					anamnesisReviewedVersion: 2,
				})}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis: vi.fn() }}
			/>,
		);
		expect(screen.getByText("New version v3 pending")).toBeTruthy();
		// Re-approval is still offered — it re-binds the current version.
		expect(screen.getByText("Approve anamnesis")).toBeTruthy();
	});

	it("renders the approved chip instead of buttons on an approved record", () => {
		render(
			<ConsultationDetailPage
				c={detail({
					anamnesisVersion: 2,
					anamnesisReviewedAt: new Date("2026-11-06T15:00:00"),
					anamnesisReviewedVersion: 2,
				})}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis: vi.fn() }}
			/>,
		);
		expect(screen.getByText("Approved v2")).toBeTruthy();
		expect(screen.queryByText("Approve anamnesis")).toBeNull();
	});

	it("defers the record through the popover calendar", async () => {
		const user = userEvent.setup();
		const deferConsultation = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), deferConsultation }}
			/>,
		);
		await user.click(screen.getByText("Defer review"));
		// Pick the first enabled day button in the grid.
		const day = document.querySelector<HTMLButtonElement>(
			'[data-slot="popover-content"] button[data-day]:not([disabled])',
		)!;
		await user.click(day);
		expect(deferConsultation).toHaveBeenCalledWith({
			data: { id: 10, until: expect.any(String) },
		});
	});

	it("shows the deferred state and resumes through the popover", async () => {
		const user = userEvent.setup();
		const deferConsultation = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ deferredUntil: new Date(Date.now() + 86_400_000) })}
				history={null}
				api={{ getConsultation: vi.fn(), deferConsultation }}
			/>,
		);
		expect(screen.getAllByText(/Deferred until/).length).toBeGreaterThan(0);
		await user.click(screen.getByRole("button", { name: /Deferred until/ }));
		await user.click(await screen.findByText("Back to the queue"));
		expect(deferConsultation).toHaveBeenCalledWith({ data: { id: 10, until: null } });
	});

	it("ignores a second click while a review call is in flight", async () => {
		const user = userEvent.setup();
		let release!: (v: { ok: boolean }) => void;
		const gate = new Promise<{ ok: boolean }>((res) => (release = res));
		const reviewTranscript = vi.fn(() => gate);
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript }}
			/>,
		);
		const btn = screen.getByText("Confirm transcript");
		await user.click(btn);
		fireEvent.click(btn); // busy guard → no second call (fireEvent ignores disabled)
		release({ ok: true });
		await screen.findByText(/Confirmed/);
		expect(reviewTranscript).toHaveBeenCalledTimes(1);
	});

	it("offers Generate anamnesis on transcript-only records and reloads", async () => {
		const user = userEvent.setup();
		const generateAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesis: null })}
				history={null}
				api={{ getConsultation: vi.fn(), generateAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Generate anamnesis"));
		expect(generateAnamnesis).toHaveBeenCalledWith({
			data: {
				consultationId: 10,
				transcript: "Médico: oi\nPaciente: olá doutor",
				patientId: 1,
			},
		});
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
	});

	it("leaves the record unstamped when the review call is refused", async () => {
		const user = userEvent.setup();
		const reviewTranscript = vi.fn(async () => ({ ok: false }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript }}
			/>,
		);
		await user.click(screen.getByText("Confirm transcript"));
		await waitFor(() => expect(reviewTranscript).toHaveBeenCalledWith({ data: 10 }));
		await act(async () => {});
		expect(screen.queryByText(/Confirmed/)).toBeNull();
		expect(screen.getByText("Confirm transcript")).toBeTruthy();
	});

	it("approves an anamnesis whose version column is unset", async () => {
		const user = userEvent.setup();
		const approveAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Approve anamnesis"));
		expect(approveAnamnesis).toHaveBeenCalledWith({ data: 10 });
		expect(await screen.findByText("Anamnesis approved")).toBeTruthy();
	});

	it("omits patientId from the generate call on unlinked records", async () => {
		const user = userEvent.setup();
		const generateAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesis: null, patientId: null })}
				history={null}
				api={{ getConsultation: vi.fn(), generateAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Generate anamnesis"));
		expect(generateAnamnesis).toHaveBeenCalledWith({
			data: { consultationId: 10, transcript: BASE.transcript },
		});
	});

	it("does not re-defer when the calendar day is deselected", async () => {
		const user = userEvent.setup();
		const deferConsultation = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ deferredUntil: new Date(Date.now() + 86_400_000) })}
				history={null}
				api={{ getConsultation: vi.fn(), deferConsultation }}
			/>,
		);
		await user.click(screen.getAllByText(/Deferred until/)[0]!);
		// Clicking the already-selected day deselects it — onSelect gets
		// undefined and the defer call must not fire again.
		const selected = document.querySelector<HTMLButtonElement>(
			'[data-slot="popover-content"] button[data-day][data-selected-single="true"]',
		);
		expect(selected).toBeTruthy();
		await user.click(selected!);
		await act(async () => {});
		expect(deferConsultation).not.toHaveBeenCalled();
	});
	it("edits a karaoke segment inline and persists the Loro edit log", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: true,
		}));
		const segments = [
			{ start: 0, end: 2, text: "dor no peito" },
			{ start: 2, end: 5, text: "desde ontem" },
		];
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k1",
					audioStatus: "done",
					serverTranscript: "dor no peito desde ontem",
					transcriptSegments: JSON.stringify(segments),
				})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		// The karaoke rows carry a pencil on hover — same editor as review mode.
		await user.click(screen.getAllByTitle("Edit line")[0]!);
		const box = screen.getByRole("textbox");
		await user.clear(box);
		await user.type(box, "dor no peito esquerdo");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(saveTranscriptEdits).toHaveBeenCalledTimes(1));
		const payload = saveTranscriptEdits.mock.calls[0]![0] as {
			data: { id: number; edits: string };
		};
		expect(payload.data.id).toBe(10);
		const entries = JSON.parse(payload.data.edits) as {
			seg?: number;
			text?: string;
			u: string;
		}[];
		expect(entries).toHaveLength(1);
		expect(entries[0]!.seg).toBe(0);
		expect(entries[0]!.text).toBe("dor no peito esquerdo");
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
		// The saved delta re-projects the row: edited tag marks the segment.
		expect(await screen.findByText("edited")).toBeTruthy();
	});

	it("full-text edit on segment-less rows lands in the same edit log", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: true,
		}));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		await user.click(screen.getByText("Edit transcript"));
		const box = screen.getByRole("textbox");
		await user.clear(box);
		await user.type(box, "transcript corrigida");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(saveTranscriptEdits).toHaveBeenCalledTimes(1));
		const payload = saveTranscriptEdits.mock.calls[0]![0] as {
			data: { id: number; edits: string };
		};
		const entries = JSON.parse(payload.data.edits) as { seg?: number; u: string }[];
		expect(entries).toHaveLength(1);
		expect(entries[0]!.seg).toBeUndefined();
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
	});

	it("hides transcript editing when the api cannot persist edits", () => {
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k1",
					audioStatus: "done",
					serverTranscript: "dor no peito",
					transcriptSegments: JSON.stringify([{ start: 0, end: 2, text: "dor no peito" }]),
				})}
				history={null}
				api={{ getConsultation: vi.fn() }}
			/>,
		);
		expect(screen.queryByTitle("Edit line")).toBeNull();
		expect(screen.queryByText("Edit transcript")).toBeNull();
	});

	it("a rejected confirm leaves the transcript unstamped", async () => {
		const user = userEvent.setup();
		const reviewTranscript = vi.fn(async () => ({ ok: false }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript }}
			/>,
		);
		await user.click(screen.getByText("Confirm transcript"));
		await waitFor(() => expect(reviewTranscript).toHaveBeenCalledWith({ data: 10 }));
		// Still offered — the stamp only lands on ok.
		expect(screen.getByText("Confirm transcript")).toBeTruthy();
	});

	it("generate anamnesis omits patientId for unlinked records", async () => {
		const user = userEvent.setup();
		const generateAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesis: null, patientId: null })}
				history={null}
				api={{ getConsultation: vi.fn(), generateAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Generate anamnesis"));
		expect(generateAnamnesis).toHaveBeenCalledWith({
			data: { consultationId: 10, transcript: expect.any(String) },
		});
	});

	it("a rejected transcript edit keeps the editor open", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: false,
		}));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		await user.click(screen.getByText("Edit transcript"));
		await user.type(screen.getByRole("textbox"), "x");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(saveTranscriptEdits).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("textbox")).toBeTruthy();
	});

	it("cancels a full-text transcript edit", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: true,
		}));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		await user.click(screen.getByText("Edit transcript"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(saveTranscriptEdits).not.toHaveBeenCalled();
	});

	it("cancels an inline segment edit from the player panel", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: true,
		}));
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k1",
					audioStatus: "done",
					serverTranscript: "dor no peito",
					transcriptSegments: JSON.stringify([{ start: 0, end: 2, text: "dor no peito" }]),
				})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		await user.click(screen.getAllByTitle("Edit line")[0]!);
		expect(screen.getByRole("textbox")).toBeTruthy();
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(saveTranscriptEdits).not.toHaveBeenCalled();
	});

	it("dedupes re-saved entries against the stored edit log", async () => {
		const user = userEvent.setup();
		const saveTranscriptEdits = vi.fn(async (_input: { data: { id: number; edits: string } }) => ({
			ok: true,
		}));
		const stored = serializeTranscriptEdits([
			{
				at: "2026-01-01T00:00:00Z",
				by: "u1",
				u: bytesToB64(genesisUpdate("dor no peito")),
			},
		]);
		render(
			<ConsultationDetailPage
				c={detail({
					audioKey: "k1",
					audioStatus: "done",
					serverTranscript: "dor no peito",
					transcriptSegments: JSON.stringify([{ start: 0, end: 2, text: "dor no peito" }]),
					transcriptEdits: stored,
					transcriptEditsBase: "transcript",
				})}
				history={null}
				api={{ getConsultation: vi.fn(), saveTranscriptEdits }}
			/>,
		);
		await user.click(screen.getAllByTitle("Edit line")[0]!);
		const box = screen.getByRole("textbox");
		await user.clear(box);
		await user.type(box, "dor corrigido");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(saveTranscriptEdits).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
	});
});

describe("ConsultationDetailPage — residual branches", () => {
	it("approves a record whose anamnesis carries no stored version", async () => {
		const user = userEvent.setup();
		const approveAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Approve anamnesis"));
		expect(approveAnamnesis).toHaveBeenCalledWith({ data: 10 });
	});

	it("ignores a deselected day in the defer calendar", async () => {
		const user = userEvent.setup();
		const deferConsultation = vi.fn(async () => ({ ok: true }));
		const deferredUntil = new Date(Date.now() + 86_400_000);
		render(
			<ConsultationDetailPage
				c={detail({ deferredUntil })}
				history={null}
				api={{ getConsultation: vi.fn(), deferConsultation }}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Deferred until/ }));
		// The deferred day renders pre-selected; clicking it deselects,
		// so onSelect fires with undefined and no defer call happens.
		const selected =
			document.querySelector<HTMLButtonElement>(
				'[data-slot="popover-content"] button[data-selected-single]',
			) ??
			[
				...document.querySelectorAll<HTMLButtonElement>(
					'[data-slot="popover-content"] button[data-day]',
				),
			].find((b) => b.dataset.day === deferredUntil.toLocaleDateString());
		expect(selected).toBeTruthy();
		await user.click(selected!);
		expect(deferConsultation).not.toHaveBeenCalled();
	});
});

describe("ConsultationDetailPage — review edge cases", () => {
	it("a failed review call leaves the stamp unset", async () => {
		const user = userEvent.setup();
		const reviewTranscript = vi.fn(async () => ({ ok: false }));
		render(
			<ConsultationDetailPage
				c={detail({})}
				history={null}
				api={{ getConsultation: vi.fn(), reviewTranscript }}
			/>,
		);
		await user.click(screen.getByText("Confirm transcript"));
		await waitFor(() => expect(reviewTranscript).toHaveBeenCalledWith({ data: 10 }));
		expect(screen.queryByText(/Confirmed/)).toBeNull();
		expect(screen.getByText("Confirm transcript")).toBeTruthy();
	});

	it("approve on a record without anamnesisVersion stamps null", async () => {
		const user = userEvent.setup();
		const approveAnamnesis = vi.fn(async () => ({ ok: true }));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesisVersion: undefined })}
				history={null}
				api={{ getConsultation: vi.fn(), approveAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Approve anamnesis"));
		await waitFor(() => expect(approveAnamnesis).toHaveBeenCalledWith({ data: 10 }));
	});

	it("generate hides when the live poll nulls the transcript", async () => {
		const user = userEvent.setup();
		const generateAnamnesis = vi.fn(async () => ({ ok: true }));
		const getConsultation = vi.fn(async () => ({
			id: 10,
			audioStatus: "done",
			serverTranscript: "srv",
			correctedTranscript: "corr",
			transcript: null,
		}));
		render(
			<ConsultationDetailPage
				c={detail({ anamnesis: null, audioStatus: "processing" })}
				history={null}
				api={{ getConsultation, generateAnamnesis }}
			/>,
		);
		// The pipeline poll overlays transcript:null onto the detail — the
		// Generate button hides while the transcript is empty.
		await waitFor(() => expect(getConsultation).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByText("Generate anamnesis")).toBeNull());
	});

	it("generate omits patientId for unlinked records", async () => {
		const user = userEvent.setup();
		const generateAnamnesis = vi.fn<NonNullable<ConsultationDetailApi["generateAnamnesis"]>>(
			async () => ({ ok: true }),
		);
		render(
			<ConsultationDetailPage
				c={detail({ anamnesis: null, patientId: null })}
				history={null}
				api={{ getConsultation: vi.fn(), generateAnamnesis }}
			/>,
		);
		await user.click(screen.getByText("Generate anamnesis"));
		await waitFor(() => expect(generateAnamnesis).toHaveBeenCalled());
		expect(generateAnamnesis.mock.calls[0]![0].data.patientId).toBeUndefined();
	});

	it("re-clicking the deferred day deselects without calling defer", async () => {
		const user = userEvent.setup();
		const deferConsultation = vi.fn(async () => ({ ok: true }));
		const until = new Date(Date.now() + 86_400_000);
		render(
			<ConsultationDetailPage
				c={detail({ deferredUntil: until })}
				history={null}
				api={{ getConsultation: vi.fn(), deferConsultation }}
			/>,
		);
		await user.click(screen.getAllByText(/Deferred until/)[0]!);
		// The calendar opens with the deferred day selected — clicking it
		// again deselects (onSelect(undefined)) instead of re-deferring.
		// rdp v10 marks the selected gridcell; the DayButton sits inside it.
		const cell = document.querySelector<HTMLElement>(
			'[data-slot="popover-content"] [data-day][data-selected]',
		);
		const dayButton = cell?.querySelector("button");
		expect(dayButton).toBeTruthy();
		await user.click(dayButton!);
		expect(deferConsultation).not.toHaveBeenCalled();
	});
});
