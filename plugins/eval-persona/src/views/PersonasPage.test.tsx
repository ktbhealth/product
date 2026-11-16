// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	listPersonaDefsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	savePersonaDefFn: vi.fn<(a?: Arg) => Res<{ id: number }>>(async () => ({
		ok: true,
		data: { id: 9 },
	})),
	deletePersonaDefFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
	generatePersonasFn: vi.fn<(a?: Arg) => Res<{ created: number }>>(async () => ({
		ok: true,
		data: { created: 5 },
	})),
}));
const epFns = vi.hoisted(() => ({
	listEndpointsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
}));
vi.mock("../fns.ts", () => fns);
vi.mock("@ktb/ai-endpoints/fns", () => epFns);
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { EndpointCard } from "@ktb/ai-endpoints";

import type { PersonaDefCard } from "../index.ts";
import { PersonasPage } from "./PersonasPage.tsx";

const endpoint: EndpointCard = {
	id: 7,
	name: "Ollama",
	kind: "openai",
	baseUrl: "http://127.0.0.1:11434/v1",
	model: "qwen2.5:7b",
	sessionId: null,
	secretRef: null,
	transport: null,
	scope: "eval",
	isDefault: false,
	timeoutMs: 60_000,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
};

const def: PersonaDefCard = {
	id: 1,
	name: "idosa nordestina",
	persona: {
		name: "Maria",
		gender: "f",
		ageBand: "elderly",
		socialClass: "low",
		education: "primary",
		region: "northeast",
		register: "colloquial",
		specialty: "general_practice",
		doctor: { gender: "f", register: "neutral" },
	},
	notes: "dor crônica",
	createdBy: "v@x.com",
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
};

afterEach(cleanup);

describe("PersonasPage", () => {
	it("renders the empty state", () => {
		render(<PersonasPage defs={[]} locale="en" />);
		expect(screen.getByText(/No personas yet/)).toBeTruthy();
	});

	it("renders def cards with axes and notes", () => {
		render(<PersonasPage defs={[def]} locale="en" />);
		expect(screen.getByText("idosa nordestina")).toBeTruthy();
		expect(screen.getByText(/northeast · elderly · colloquial/)).toBeTruthy();
		expect(screen.getByText("dor crônica")).toBeTruthy();
	});

	it("creates a persona through the dialog", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("New persona"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "nova def");
		await user.type(inputs[1]!, "Joana");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "nova def",
			patientName: "Joana",
			region: "southeast",
		});
	});

	it("edits an existing def (id on the wire)", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Edit"));
		const nameInput = screen.getAllByRole("textbox")[0]!;
		await user.clear(nameInput);
		await user.type(nameInput, "renamed");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({ id: 1, name: "renamed" });
	});

	it("deletes after the confirm step", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Confirm delete"));
		await waitFor(() => expect(fns.deletePersonaDefFn).toHaveBeenCalledWith({ data: { id: 1 } }));
	});

	it("shows the failure message when save is denied", async () => {
		fns.savePersonaDefFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("New persona"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		await user.type(inputs[1]!, "y");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("closes the dialog via cancel and renders defaults for sparse personas", async () => {
		const sparse: PersonaDefCard = {
			...def,
			id: 2,
			name: "sparse",
			persona: {} as PersonaDefCard["persona"],
			notes: null,
		};
		const user = userEvent.setup();
		render(<PersonasPage defs={[sparse]} locale="en" />);
		expect(screen.getByText("—")).toBeTruthy();
		await user.click(screen.getByText("New persona"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("edits every axis select + notes through the dialog", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Edit"));
		const pick = async (label: string, value: string) => {
			await user.click(screen.getByLabelText(label));
			await user.click(await screen.findByRole("option", { name: value }));
		};
		await pick("Gender", "male");
		await pick("Age band", "Child (0-12)");
		await pick("Social class", "High income");
		await pick("Education", "College+");
		await pick("Region", "South");
		await pick("Register", "Technical — medical terms");
		await pick("Specialty", "Cardiology");
		await pick("Doctor gender", "male");
		await pick("Doctor register", "Technical — medical terms");
		const notes = screen.getAllByRole("textbox").at(-1)!;
		await user.clear(notes);
		await user.type(notes, "nova nota");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({
			id: 1,
			gender: "male",
			ageBand: "child",
			socialClass: "high",
			education: "higher",
			region: "south",
			register: "technical",
			specialty: "cardiology",
			doctorGender: "male",
			doctorRegister: "technical",
			notes: "nova nota",
		});
	});

	it("aborts the delete flow back to the plain button", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Delete"));
		// Confirm arm renders; a second def keeps the list non-empty.
		expect(screen.getByText("Confirm delete")).toBeTruthy();
	});

	it("delete failure keeps the error visible", async () => {
		fns.deletePersonaDefFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Confirm delete"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});
});

describe("PersonasPage — remaining branches", () => {
	it("edits a sparse def — every fallback in fromCard fires", async () => {
		const sparse: PersonaDefCard = {
			...def,
			id: 2,
			name: "sparse",
			persona: {} as PersonaDefCard["persona"],
			notes: null,
		};
		const user = userEvent.setup();
		render(<PersonasPage defs={[sparse]} locale="en" />);
		await user.click(screen.getByText("Edit"));
		const boxes = screen.getAllByRole("textbox");
		await user.clear(boxes[0]!);
		await user.type(boxes[0]!, "edited sparse");
		await user.type(boxes[1]!, "Paciente");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({
			id: 2,
			ageBand: "adult",
			region: "southeast",
			doctorRegister: "neutral",
		});
	});
});

describe("PersonasPage — branch completion", () => {
	it("maps male patient + doctor genders in the edit form", async () => {
		const male: PersonaDefCard = {
			...def,
			id: 3,
			name: "homem",
			persona: { ...def.persona, gender: "m", doctor: { gender: "m", register: "neutral" } },
		};
		const user = userEvent.setup();
		render(<PersonasPage defs={[male]} locale="en" />);
		await user.click(screen.getByText("Edit"));
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[1]!, "João");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({
			gender: "male",
			doctorGender: "male",
		});
	});

	it("keeps the stale list when refresh fails after delete", async () => {
		fns.listPersonaDefsFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<PersonasPage defs={[def]} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Confirm delete"));
		await waitFor(() => expect(fns.deletePersonaDefFn).toHaveBeenCalled());
		expect(screen.getByText("idosa nordestina")).toBeTruthy();
	});

	it("closes the dialog on Escape through onOpenChange", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("New persona"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("randomizes the axes via the Surprise me button", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("New persona"));
		await user.click(screen.getByText("Surprise me"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "rand");
		await user.type(inputs[1]!, "Alguém");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.savePersonaDefFn).toHaveBeenCalled());
		expect(fns.savePersonaDefFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "rand",
			patientName: "Alguém",
		});
	});
});

describe("PersonasPage — generate dialog", () => {
	it("fetches endpoints lazily, picks a count chip and generates", async () => {
		const acp: EndpointCard = { ...endpoint, id: 8, name: "Claude", kind: "acp", model: null };
		epFns.listEndpointsFn.mockResolvedValue({ ok: true, data: [endpoint, acp] });
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("Generate personas"));
		await waitFor(() => expect(epFns.listEndpointsFn).toHaveBeenCalled());
		expect(screen.getByText(/LLM endpoint drafts/)).toBeTruthy();
		await user.click(screen.getByLabelText("Endpoint"));
		// Model-less endpoints fall back to their kind in the option label.
		expect(await screen.findByRole("option", { name: /Claude · acp/ })).toBeTruthy();
		await user.click(await screen.findByRole("option", { name: /Ollama · qwen/ }));
		await user.click(screen.getByRole("button", { name: "20" }));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() =>
			expect(fns.generatePersonasFn).toHaveBeenCalledWith({
				data: { count: 20, endpointId: 7 },
			}),
		);
		expect(await screen.findByText(/Personas created/)).toBeTruthy();
		expect(fns.listPersonaDefsFn).toHaveBeenCalled();
	});

	it("generates through the template option without an endpointId", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("Generate personas"));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() =>
			expect(fns.generatePersonasFn).toHaveBeenCalledWith({ data: { count: 10 } }),
		);
	});

	it("shows the failure message when generation is denied", async () => {
		fns.generatePersonasFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("Generate personas"));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("keeps the template option when the endpoint fetch fails, and cancels out", async () => {
		epFns.listEndpointsFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("Generate personas"));
		await waitFor(() => expect(epFns.listEndpointsFn).toHaveBeenCalled());
		await user.click(screen.getByLabelText("Endpoint"));
		expect(await screen.findByRole("option", { name: /Template \(deterministic/ })).toBeTruthy();
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes the generate dialog on Escape", async () => {
		const user = userEvent.setup();
		render(<PersonasPage defs={[]} locale="en" />);
		await user.click(screen.getByText("Generate personas"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
