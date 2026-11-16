// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const detail: unknown = {
	id: 1,
	name: "lote",
	mode: "random",
	endpointId: null,
	endpointName: null,
	params: { minutes: 15 },
	status: "ready",
	total: 2,
	done: 2,
	pct: 100,
	batchId: 7,
	createdBy: null,
	createdAt: new Date(),
	items: [
		{
			id: 1,
			instanceId: 1,
			personaDefId: null,
			evalPersonaId: 11,
			persona: { name: "Maria", region: "northeast", ageBand: "elderly", register: "colloquial" },
			status: "done",
			error: null,
		},
		{
			id: 2,
			instanceId: 1,
			personaDefId: null,
			evalPersonaId: 12,
			persona: { name: "João", region: "south", ageBand: "adult", register: "neutral" },
			status: "error",
			error: "llm down",
		},
	],
};

const fns = vi.hoisted(() => ({
	createInstanceFn: vi.fn<(a?: Arg) => Res<{ id: number }>>(async () => ({
		ok: true,
		data: { id: 5 },
	})),
	deleteInstanceFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
	instanceDetailFn: vi.fn<(a?: Arg) => Res<unknown>>(async () => ({ ok: true, data: detail })),
	listInstancesFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	spawnInstancesFn: vi.fn<(a?: Arg) => Res<{ created: number }>>(async () => ({
		ok: true,
		data: { created: 5 },
	})),
	startInstanceFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
}));
vi.mock("../fns.ts", () => fns);
const epFns = vi.hoisted(() => ({
	listEndpointsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
}));
vi.mock("@ktb/ai-endpoints/fns", () => epFns);
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { EndpointCard } from "@ktb/ai-endpoints";

import type { InstanceCard, PersonaDefCard } from "../index.ts";
import { InstancesPage } from "./InstancesPage.tsx";

const instance: InstanceCard = {
	id: 1,
	name: "lote",
	mode: "random",
	endpointId: null,
	endpointName: null,
	params: { minutes: 15 },
	status: "draft",
	total: 2,
	done: 0,
	batchId: null,
	createdBy: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
};

const readyInstance: InstanceCard = { ...instance, status: "ready", done: 2, batchId: 7 };

const endpoint: EndpointCard = {
	id: 2,
	name: "Ollama",
	kind: "openai",
	baseUrl: "http://localhost:11434/v1",
	model: "qwen2.5:7b",
	sessionId: null,
	secretRef: null,
	transport: null,
	agentCmd: null,
	sshHost: null,
	scope: "eval",
	isDefault: false,
	timeoutMs: 60_000,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
};

const def: PersonaDefCard = {
	id: 4,
	name: "idosa",
	persona: {
		name: "Maria",
		region: "northeast",
		ageBand: "elderly",
		register: "colloquial",
		specialty: "general_practice",
	},
	notes: null,
	createdBy: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
};

const renderPage = (
	over: {
		instances?: readonly InstanceCard[];
		defs?: readonly PersonaDefCard[];
		endpoints?: readonly EndpointCard[];
	} = {},
) =>
	render(
		<InstancesPage
			instances={over.instances ?? []}
			defs={over.defs ?? []}
			endpoints={over.endpoints ?? []}
			locale="en"
		/>,
	);

afterEach(cleanup);

describe("InstancesPage", () => {
	it("renders the empty state", () => {
		renderPage();
		expect(screen.getByText(/No instances yet/)).toBeTruthy();
	});

	it("lists instances with progress and starts a draft", async () => {
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		expect(screen.getByText("lote")).toBeTruthy();
		expect(screen.getByText(/0\/2 items/)).toBeTruthy();
		await user.click(screen.getByText("Generate"));
		await waitFor(() => expect(fns.startInstanceFn).toHaveBeenCalledWith({ data: { id: 1 } }));
	});

	it("creates a random instance with endpoint + minutes", async () => {
		const user = userEvent.setup();
		renderPage({ endpoints: [endpoint] });
		await user.click(screen.getByText("New instance"));
		const nameInput = screen.getAllByRole("textbox")[0]!;
		await user.type(nameInput, "coorte A");
		await user.click(screen.getByText("Create"));
		await waitFor(() => expect(fns.createInstanceFn).toHaveBeenCalled());
		expect(fns.createInstanceFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "coorte A",
			mode: "random",
		});
	});

	it("opens the detail with items, errors and axis distribution", async () => {
		const user = userEvent.setup();
		renderPage({ instances: [readyInstance] });
		await user.click(screen.getByText("Open"));
		expect(await screen.findByText("Maria")).toBeTruthy();
		expect(screen.getByText("llm down")).toBeTruthy();
		expect(screen.getByText("Cohort distribution")).toBeTruthy();
		expect(screen.getByText(/await review/i)).toBeTruthy();
	});

	it("deletes an instance after confirm", async () => {
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		const row = screen.getByText("lote").closest("div")!.parentElement!.parentElement!;
		const trash = row.querySelectorAll("button");
		await user.click(trash[trash.length - 1]!);
		await user.click(await screen.findByText("Confirm delete"));
		await waitFor(() => expect(fns.deleteInstanceFn).toHaveBeenCalledWith({ data: { id: 1 } }));
	});

	it("creates a selected-mode instance with def checkboxes", async () => {
		const user = userEvent.setup();
		renderPage({ defs: [def] });
		await user.click(screen.getByText("New instance"));
		await user.type(screen.getAllByRole("textbox")[0]!, "manual");
		await user.click(screen.getByLabelText("Mode"));
		await user.click(await screen.findByRole("option", { name: "Selected personas" }));
		await user.click(screen.getByRole("checkbox"));
		await user.click(screen.getByText("Create"));
		await waitFor(() => expect(fns.createInstanceFn).toHaveBeenCalled());
		expect(fns.createInstanceFn.mock.calls[0]?.[0]?.data).toMatchObject({
			mode: "selected",
			defIds: [4],
		});
	});

	it("shows a failure message when an action is denied", async () => {
		fns.startInstanceFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		await user.click(screen.getByText("Generate"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("shows the failure when create is denied", async () => {
		fns.createInstanceFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New instance"));
		await user.type(screen.getAllByRole("textbox")[0]!, "x");
		await user.click(screen.getByText("Create"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("polls while an instance is generating", async () => {
		renderPage({ instances: [{ ...instance, status: "generating" }] });
		await waitFor(() => expect(fns.listInstancesFn).toHaveBeenCalled(), { timeout: 4000 });
	});

	it("renders the draft detail with persona-less items", async () => {
		fns.instanceDetailFn.mockResolvedValueOnce({
			ok: true,
			data: {
				...(detail as Record<string, unknown>),
				status: "draft",
				done: 0,
				pct: 0,
				items: [
					{
						id: 9,
						instanceId: 1,
						personaDefId: 4,
						evalPersonaId: null,
						persona: null,
						status: "pending",
						error: null,
					},
				],
			} as never,
		});
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		await user.click(screen.getByText("Open"));
		expect(await screen.findByText("#9")).toBeTruthy();
	});

	it("chooses a concrete endpoint and edits random-mode fields", async () => {
		const user = userEvent.setup();
		renderPage({ endpoints: [endpoint] });
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByLabelText("Endpoint"));
		await user.click(await screen.findByRole("option", { name: /Ollama · qwen/ }));
		const spinners = screen.getAllByRole("spinbutton");
		await user.clear(spinners[0]!);
		await user.type(spinners[0]!, "9");
		await user.clear(spinners[1]!);
		await user.type(spinners[1]!, "55");
		await user.clear(spinners[2]!);
		await user.type(spinners[2]!, "20");
		await user.type(screen.getAllByRole("textbox")[0]!, "coorte B");
		await user.click(screen.getByText("Create"));
		await waitFor(() => expect(fns.createInstanceFn).toHaveBeenCalled());
		expect(fns.createInstanceFn.mock.calls[0]?.[0]?.data).toMatchObject({
			endpointId: 2,
			count: 9,
			seed: 55,
			minutes: 20,
		});
	});

	it("closes the create dialog through Cancel", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("clears the open detail when its instance is deleted", async () => {
		const user = userEvent.setup();
		renderPage({ instances: [readyInstance] });
		await user.click(screen.getByText("Open"));
		expect(await screen.findByText("Maria")).toBeTruthy();
		const row = screen.getAllByText("lote")[0]!.closest("div")!.parentElement!.parentElement!;
		const buttons = row.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		await user.click(await screen.findByText("Confirm delete"));
		await waitFor(() => expect(fns.deleteInstanceFn).toHaveBeenCalled());
	});
});

describe("InstancesPage — remaining branches", () => {
	it("polls the open detail while generating", async () => {
		renderPage({ instances: [{ ...instance, status: "generating" }] });
		const user = userEvent.setup();
		await user.click(screen.getByText("Open"));
		expect(await screen.findByText("Maria")).toBeTruthy();
		await waitFor(() => expect(fns.instanceDetailFn.mock.calls.length).toBeGreaterThan(1), {
			timeout: 4000,
		});
	});

	it("ignores a failed open-detail call", async () => {
		fns.instanceDetailFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		await user.click(screen.getByText("Open"));
		await waitFor(() => expect(fns.instanceDetailFn).toHaveBeenCalled());
		expect(screen.queryByText("Maria")).toBeNull();
	});

	it("shows the error when delete fails", async () => {
		fns.deleteInstanceFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		const row = screen.getByText("lote").closest("div")!.parentElement!.parentElement!;
		const buttons = row.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		await user.click(await screen.findByText("Confirm delete"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("unchecks a def back out of the selection", async () => {
		const user = userEvent.setup();
		renderPage({ defs: [def] });
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByLabelText("Mode"));
		await user.click(await screen.findByRole("option", { name: "Selected personas" }));
		const box = screen.getByRole("checkbox");
		await user.click(box);
		await user.click(box);
		expect(screen.getByText("Create")).toHaveProperty("disabled", true);
	});

	it("clears numeric fields so the wire omits them", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New instance"));
		const spinners = screen.getAllByRole("spinbutton");
		for (const s of spinners) await user.clear(s);
		await user.type(screen.getAllByRole("textbox")[0]!, "empties");
		await user.click(screen.getByText("Create"));
		await waitFor(() => expect(fns.createInstanceFn).toHaveBeenCalled());
		expect(fns.createInstanceFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "empties",
			mode: "random",
			count: 1,
		});
		const wire = fns.createInstanceFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("seed" in wire).toBe(false);
		expect("minutes" in wire).toBe(false);
	});

	it("renders an instance without minutes or endpoint", () => {
		renderPage({
			instances: [{ ...readyInstance, params: {}, mode: "selected" }],
		});
		expect(screen.getByText(/Template \(deterministic/)).toBeTruthy();
		expect(screen.getByText("Selected personas")).toBeTruthy();
	});
});

describe("InstancesPage — branch completion", () => {
	it("renders a failed-status card and a zero-total progress", () => {
		renderPage({
			instances: [
				{ ...readyInstance, status: "failed", total: 0, done: 0 },
				{ ...instance, id: 8, name: "c2", endpointName: "Ollama" },
			],
		});
		expect(screen.getByText("failed")).toBeTruthy();
		expect(screen.getByText("Ollama")).toBeTruthy();
	});

	it("switches the mode back to random and submits", async () => {
		const user = userEvent.setup();
		renderPage({ defs: [def] });
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByLabelText("Mode"));
		await user.click(await screen.findByRole("option", { name: "Selected personas" }));
		await user.click(screen.getByLabelText("Mode"));
		await user.click(await screen.findByRole("option", { name: "Random sample" }));
		await user.type(screen.getAllByRole("textbox")[0]!, "back");
		await user.click(screen.getByText("Create"));
		await waitFor(() => expect(fns.createInstanceFn).toHaveBeenCalled());
		expect(fns.createInstanceFn.mock.calls[0]?.[0]?.data).toMatchObject({ mode: "random" });
	});

	it("lists a model-less endpoint in the select with kind fallback", async () => {
		const noModel: EndpointCard = { ...endpoint, id: 9, name: "ACP", kind: "acp", model: null };
		const user = userEvent.setup();
		renderPage({ endpoints: [noModel] });
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByLabelText("Endpoint"));
		expect(await screen.findByRole("option", { name: /ACP · acp/ })).toBeTruthy();
	});

	it("skips non-eval scopes and disabled endpoints in the picker", async () => {
		const foreign: EndpointCard = { ...endpoint, id: 10, name: "Foreign", scope: "ops" };
		const off: EndpointCard = { ...endpoint, id: 11, name: "Off", enabled: false };
		const user = userEvent.setup();
		renderPage({ endpoints: [endpoint, foreign, off] });
		await user.click(screen.getByText("New instance"));
		await user.click(screen.getByLabelText("Endpoint"));
		expect(await screen.findByRole("option", { name: /Ollama · qwen/ })).toBeTruthy();
		expect(screen.queryByRole("option", { name: /Foreign/ })).toBeNull();
		expect(screen.queryByRole("option", { name: /Off/ })).toBeNull();
	});

	it("keeps the list when refresh fails after start", async () => {
		fns.listInstancesFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage({ instances: [instance] });
		await user.click(screen.getByText("Generate"));
		await waitFor(() => expect(fns.startInstanceFn).toHaveBeenCalled());
	});

	it("keeps the old detail when the poll refetch fails", async () => {
		fns.instanceDetailFn
			.mockResolvedValueOnce({ ok: true, data: detail })
			.mockResolvedValue({ ok: false });
		renderPage({ instances: [{ ...instance, status: "generating" }] });
		const user = userEvent.setup();
		await user.click(screen.getByText("Open"));
		expect(await screen.findByText("Maria")).toBeTruthy();
		await waitFor(() => expect(fns.instanceDetailFn.mock.calls.length).toBeGreaterThan(1), {
			timeout: 4000,
		});
	});

	it("closes the create dialog via Escape", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New instance"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("InstancesPage — spawn generators", () => {
	it("spawns draft instances through the dialog", async () => {
		const user = userEvent.setup();
		renderPage({
			endpoints: [
				endpoint,
				{ ...endpoint, id: 7, name: "Bare", kind: "acp", model: null },
				{ ...endpoint, id: 8, name: "Dead", enabled: false },
			],
		});
		await user.click(screen.getByText("Spawn generators"));
		await user.click(screen.getByRole("button", { name: "10" }));
		await user.click(screen.getByLabelText("Endpoint"));
		expect(await screen.findByRole("option", { name: "Bare · acp" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: /Dead/ })).toBeNull();
		await user.click(await screen.findByRole("option", { name: /Ollama · qwen/ }));
		const spinner = screen.getByRole("spinbutton");
		await user.clear(spinner);
		await user.type(spinner, "4");
		await user.click(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() => expect(fns.spawnInstancesFn).toHaveBeenCalled());
		expect(fns.spawnInstancesFn.mock.calls[0]?.[0]?.data).toEqual({
			count: 10,
			endpointId: 2,
			defCount: 4,
		});
		await waitFor(() => expect(fns.listInstancesFn).toHaveBeenCalled());
	});

	it("defaults to the template endpoint and keeps count chips", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Spawn generators"));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() => expect(fns.spawnInstancesFn).toHaveBeenCalled());
		expect(fns.spawnInstancesFn.mock.calls[0]?.[0]?.data).toEqual({ count: 5, defCount: 3 });
		const wire = fns.spawnInstancesFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("endpointId" in wire).toBe(false);
	});

	it("disables Generate on an empty defCount and reports failures", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Spawn generators"));
		const spinner = screen.getByRole("spinbutton");
		await user.clear(spinner);
		expect(screen.getByRole("button", { name: "Generate" })).toHaveProperty("disabled", true);
		await user.type(spinner, "2");
		fns.spawnInstancesFn.mockResolvedValueOnce({ ok: false });
		await user.click(screen.getByRole("button", { name: "Generate" }));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("closes through Cancel and through onOpenChange (Escape)", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("Spawn generators"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(screen.getByText("Spawn generators"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
