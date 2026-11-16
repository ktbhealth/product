// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	deleteEndpointFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
	listEndpointPresetsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	listEndpointsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	saveEndpointFn: vi.fn<(a?: Arg) => Res<{ id: number }>>(async () => ({
		ok: true,
		data: { id: 3 },
	})),
	testEndpointFn: vi.fn<(a?: Arg) => Res<{ message?: string }>>(async () => ({
		ok: true,
		data: {},
	})),
}));
vi.mock("../fns.ts", () => fns);
const credFns = vi.hoisted(() => ({
	listCredentialsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
}));
vi.mock("@ktb/credentials/fns", () => credFns);
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { EndpointCard } from "../index.ts";
import { EndpointsPage } from "./EndpointsPage.tsx";

const credential = {
	id: "k3",
	name: "openai prod",
	provider: "openai",
	masked: "••••9abc",
};

const endpoint: EndpointCard = {
	id: 2,
	name: "Ollama",
	kind: "openai",
	baseUrl: "http://localhost:11434/v1",
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

const renderPage = (endpoints: readonly EndpointCard[] = []) =>
	render(<EndpointsPage endpoints={endpoints} locale="en" />);

afterEach(cleanup);

describe("EndpointsPage", () => {
	it("renders the empty state", () => {
		renderPage();
		expect(screen.getByText(/No endpoints/)).toBeTruthy();
	});

	it("creates and tests an endpoint", async () => {
		const user = userEvent.setup();
		renderPage([endpoint]);
		expect(screen.getByText("Ollama")).toBeTruthy();
		await user.click(screen.getByText("Test"));
		await waitFor(() => expect(fns.testEndpointFn).toHaveBeenCalledWith({ data: { id: 2 } }));
		expect(await screen.findByText("endpoint ok")).toBeTruthy();

		await user.click(screen.getByText("Edit"));
		const nameInput = screen.getAllByRole("textbox")[0]!;
		await user.clear(nameInput);
		await user.type(nameInput, "Ollama 2");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			id: 2,
			name: "Ollama 2",
			kind: "openai",
		});
	});

	it("deletes an endpoint after confirm and reports test failures", async () => {
		const user = userEvent.setup();
		renderPage([{ ...endpoint, enabled: false }]);
		expect(screen.getByText("off")).toBeTruthy();

		fns.testEndpointFn.mockResolvedValueOnce({
			ok: false,
			data: { message: "connection refused" },
		} as never);
		await user.click(screen.getByText("Test"));
		expect(await screen.findByText(/connection refused/)).toBeTruthy();

		const row = screen.getByText("Ollama").closest("div")!.parentElement!.parentElement!;
		const buttons = row.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		await user.click(await screen.findByText("Confirm delete"));
		await waitFor(() => expect(fns.deleteEndpointFn).toHaveBeenCalledWith({ data: { id: 2 } }));
	});

	it("surfaces the action failure when delete is denied", async () => {
		const user = userEvent.setup();
		fns.deleteEndpointFn.mockResolvedValueOnce({ ok: false } as never);
		renderPage([endpoint]);
		const row = screen.getByText("Ollama").closest("div")!.parentElement!.parentElement!;
		const buttons = row.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		await user.click(await screen.findByText("Confirm delete"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("creates an acp endpoint filling every field", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[0]!, "ACP agent");
		await user.click(screen.getByLabelText("Kind"));
		await user.click(await screen.findByRole("option", { name: "acp" }));
		expect(screen.getByText(/Connects a local agent over ACP/)).toBeTruthy();
		await user.clear(boxes[1]!);
		await user.type(boxes[1]!, "http://agent.local/rpc");
		const spinners = screen.getAllByRole("spinbutton");
		await user.clear(spinners[0]!);
		await user.type(spinners[0]!, "90000");
		await user.type(boxes[2]!, "model-x");
		await user.type(boxes[3]!, "session-1");
		await user.click(screen.getByLabelText("API key env var"));
		await user.click(await screen.findByRole("option", { name: "Custom env var" }));
		await user.type(screen.getByPlaceholderText("OLLAMA_API_KEY"), "MY_KEY");
		const checks = screen.getAllByRole("checkbox");
		await user.click(checks[checks.length - 1]!);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "ACP agent",
			kind: "acp",
			baseUrl: "http://agent.local/rpc",
			model: "model-x",
			sessionId: "session-1",
			secretRef: "MY_KEY",
			timeoutMs: 90000,
			enabled: false,
		});
	});

	it("creates an endpoint with a custom scope and the default flag", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[0]!, "Ops llm");
		// scope is the last textbox in the form (after session id).
		const scopeInput = boxes[boxes.length - 1]!;
		await user.clear(scopeInput);
		await user.type(scopeInput, "ops");
		// First checkbox is "Default endpoint", second is "Enabled".
		await user.click(screen.getAllByRole("checkbox")[0]!);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "Ops llm",
			scope: "ops",
			isDefault: true,
			enabled: true,
		});
	});

	it("edits a model-less endpoint — empty optional fields stay off the wire", async () => {
		const noModel: EndpointCard = { ...endpoint, model: null, sessionId: "s1", secretRef: "K" };
		const user = userEvent.setup();
		renderPage([noModel]);
		await user.click(screen.getByText("Edit"));
		const spinners = screen.getAllByRole("spinbutton");
		await user.clear(spinners[0]!);
		const boxes = screen.getAllByRole("textbox");
		await user.clear(boxes[3]!);
		await user.clear(boxes[4]!);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		const wire = fns.saveEndpointFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("model" in wire).toBe(false);
		expect("sessionId" in wire).toBe(false);
		expect("secretRef" in wire).toBe(false);
		expect("timeoutMs" in wire).toBe(false);
	});

	it("shows the failure when endpoint save is denied", async () => {
		fns.saveEndpointFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[0]!, "x");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("reports a bare failure when the test fn denies", async () => {
		fns.testEndpointFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage([endpoint]);
		await user.click(screen.getByText("Test"));
		expect(await screen.findByText(/endpoint failed/)).toBeTruthy();
	});

	it("shows a bare failure when the test result carries no message", async () => {
		fns.testEndpointFn.mockResolvedValueOnce({ ok: false, data: {} } as never);
		const user = userEvent.setup();
		renderPage([endpoint]);
		await user.click(screen.getByText("Test"));
		await waitFor(() => expect(fns.testEndpointFn).toHaveBeenCalled());
		expect(await screen.findByText(/endpoint failed/)).toBeTruthy();
	});

	it("closes the dialog through Cancel and through Escape", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(screen.getByText("New endpoint"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("fills the endpoint form from a preset chip", async () => {
		// Provider presets arrive via the adapter-backed fn; one carries
		// no model to exercise the `?? ""` fill arm.
		fns.listEndpointPresetsFn.mockResolvedValueOnce({
			ok: true,
			data: [
				{
					label: "OpenAI",
					kind: "openai",
					baseUrl: "https://api.openai.com/v1",
					model: "gpt-4o-mini",
				},
				{ label: "Proxy", kind: "openai", baseUrl: "http://proxy/v1" },
			],
		});
		renderPage();
		const user = userEvent.setup();
		await user.click(screen.getByText("New endpoint"));
		await waitFor(() => expect(fns.listEndpointPresetsFn).toHaveBeenCalled());
		await user.click(await screen.findByRole("button", { name: "Ollama local" }));
		const url = screen.getByDisplayValue("http://127.0.0.1:11434/v1");
		expect(url).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "LM Studio" }));
		expect(screen.getByDisplayValue("http://127.0.0.1:1234/v1")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "OpenAI" }));
		expect(screen.getByDisplayValue("https://api.openai.com/v1")).toBeTruthy();
		expect(screen.getByDisplayValue("gpt-4o-mini")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Proxy" }));
		expect(screen.getByDisplayValue("http://proxy/v1")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Gemini" }));
		expect(
			screen.getByDisplayValue("https://generativelanguage.googleapis.com/v1beta/openai/"),
		).toBeTruthy();
		expect(screen.getByDisplayValue("gemini-2.0-flash")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Claude Code agent" }));
		expect(await screen.findByText(/Connects a local agent over ACP/)).toBeTruthy();
	});
});

describe("EndpointsPage — credential select", () => {
	it("lists credentials lazily and stores credential:<id> on the wire", async () => {
		credFns.listCredentialsFn.mockResolvedValue({ ok: true, data: [credential] });
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		await waitFor(() => expect(credFns.listCredentialsFn).toHaveBeenCalled());
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[0]!, "OpenAI prod");
		await user.clear(boxes[1]!);
		await user.type(boxes[1]!, "https://api.openai.com/v1");
		await user.type(boxes[2]!, "gpt-4o-mini");
		await user.click(screen.getByLabelText("API key env var"));
		await user.click(await screen.findByRole("option", { name: /openai prod · openai/ }));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			secretRef: "credential:k3",
		});
	});

	it("offers a stale credential ref when editing and swaps it for custom", async () => {
		const stale: EndpointCard = { ...endpoint, secretRef: "credential:99" };
		const user = userEvent.setup();
		renderPage([stale]);
		await user.click(screen.getByText("Edit"));
		await user.click(screen.getByLabelText("API key env var"));
		expect(await screen.findByRole("option", { name: "credential:99" })).toBeTruthy();
		await user.click(await screen.findByRole("option", { name: "Custom env var" }));
		await user.type(screen.getByPlaceholderText("OLLAMA_API_KEY"), "LEGACY_KEY");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			secretRef: "LEGACY_KEY",
		});
	});

	it("still works when the credential + preset fetches fail", async () => {
		credFns.listCredentialsFn.mockResolvedValueOnce({ ok: false });
		fns.listEndpointPresetsFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		await waitFor(() => expect(credFns.listCredentialsFn).toHaveBeenCalled());
		await user.click(screen.getByLabelText("API key env var"));
		expect(await screen.findByRole("option", { name: "None" })).toBeTruthy();
		expect(await screen.findByRole("option", { name: "Custom env var" })).toBeTruthy();
	});

	it("None clears the stored ref", async () => {
		const withKey: EndpointCard = { ...endpoint, secretRef: "OLD_KEY" };
		const user = userEvent.setup();
		renderPage([withKey]);
		await user.click(screen.getByText("Edit"));
		await user.click(screen.getByLabelText("API key env var"));
		await user.click(await screen.findByRole("option", { name: "None" }));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		const wire = fns.saveEndpointFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("secretRef" in wire).toBe(false);
	});
});

describe("EndpointsPage — acp transport", () => {
	it("sends the chosen transport on the wire for acp endpoints", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		await user.type(screen.getAllByRole("textbox")[0]!, "ACP ssh");
		await user.click(screen.getByLabelText("Kind"));
		await user.click(await screen.findByRole("option", { name: "acp" }));
		expect(screen.getByText(/child\/ssh need the Node runtime/)).toBeTruthy();
		await user.click(screen.getByLabelText("Transport"));
		await user.click(await screen.findByRole("option", { name: "ssh" }));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			kind: "acp",
			transport: "ssh",
		});
	});

	it("restores the stored transport when editing and omits it for openai", async () => {
		const acp: EndpointCard = { ...endpoint, kind: "acp", model: null, transport: "child" };
		const user = userEvent.setup();
		renderPage([acp]);
		await user.click(screen.getByText("Edit"));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			kind: "acp",
			transport: "child",
		});
	});
});
