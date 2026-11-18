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
	createBridgeLinkFn: vi.fn<(a?: Arg) => Res<{ command: string; expiresAt: Date } | null>>(
		async () => ({
			ok: true,
			data: {
				command:
					'bun /repo/packages/ai-bridge/src/cli.ts connect https://app.test/api/ai/bridge?token=tok123 --cmd "bunx @agentclientprotocol/claude-agent-acp"',
				expiresAt: new Date("2026-11-01T10:15:00Z"),
			},
		}),
	),
	endpointBridgeStatusFn: vi.fn<
		(a?: Arg) => Res<{ status: string; lastSeenAt: Date | null } | null>
	>(async () => ({ ok: true, data: { status: "waiting", lastSeenAt: null } })),
	setPlatformDefaultEndpointFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({
		ok: true,
		data: null,
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
const machineFns = vi.hoisted(() => ({
	machinesListFn: vi.fn<(a?: Arg) => Promise<readonly unknown[]>>(async () => []),
}));
vi.mock("@ktb/machines/fns", () => machineFns);
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
	agentCmd: null,
	sshHost: null,
	machineId: null,
	scope: "eval",
	isDefault: false,
	timeoutMs: 60_000,
	enabled: true,
	lastSeenAt: null,
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

	it("renders the default badge and omits a cleared scope on save", async () => {
		const user = userEvent.setup();
		renderPage([{ ...endpoint, isDefault: true }]);
		expect(screen.getByText("default")).toBeTruthy();
		await user.click(screen.getByText("Edit"));
		// Scope is the last textbox in the form — clearing it keeps the
		// key off the wire entirely.
		const boxes = screen.getAllByRole("textbox");
		await user.clear(boxes[boxes.length - 1]!);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		const wire = fns.saveEndpointFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("scope" in wire).toBe(false);
	});

	it("promotes an endpoint to platform default", async () => {
		const user = userEvent.setup();
		renderPage([endpoint]);
		await user.click(screen.getByText("Set as platform default"));
		await waitFor(() =>
			expect(fns.setPlatformDefaultEndpointFn).toHaveBeenCalledWith({ data: { id: 2 } }),
		);
	});

	it("hides the promote action on the current platform default", () => {
		renderPage([{ ...endpoint, scope: "platform", isDefault: true }]);
		expect(screen.queryByText("Set as platform default")).toBeNull();
	});

	it("surfaces the failure when the platform-default swap is denied", async () => {
		const user = userEvent.setup();
		fns.setPlatformDefaultEndpointFn.mockResolvedValueOnce({ ok: false } as never);
		renderPage([endpoint]);
		await user.click(screen.getByText("Set as platform default"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
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
		await user.type(screen.getByPlaceholderText("claude-agent-acp"), "claude-agent-acp --verbose");
		await user.type(screen.getByPlaceholderText("user@host"), "me@gpu-box");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			kind: "acp",
			transport: "ssh",
			agentCmd: "claude-agent-acp --verbose",
			sshHost: "me@gpu-box",
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

describe("EndpointsPage — bridge (F3b)", () => {
	const bridgeEp: EndpointCard = {
		...endpoint,
		id: 7,
		name: "Local agent",
		kind: "acp",
		baseUrl: "",
		transport: "ws",
	};

	it("flags bridge cards and offers Connect via bridge only for bridge endpoints", () => {
		renderPage([endpoint, bridgeEp, { ...bridgeEp, id: 8, name: "Off agent", enabled: false }]);
		// Each bridge row shows the badge in two places (badge + url
		// cell); the openai row shows none.
		expect(screen.getAllByText("bridge").length).toBeGreaterThanOrEqual(2);
		// Disabled bridge endpoints get no connect action.
		expect(screen.getAllByText("Connect via bridge")).toHaveLength(1);
	});

	it("mints the connect command, shows it once, polls status, and copies", async () => {
		const user = userEvent.setup();
		// userEvent installs its own clipboard stub on setup — spy on
		// the instance it left behind rather than racing it.
		const writeText = vi.spyOn(navigator.clipboard, "writeText");
		renderPage([bridgeEp]);
		await user.click(screen.getByText("Connect via bridge"));
		await waitFor(() => expect(fns.createBridgeLinkFn).toHaveBeenCalledWith({ data: { id: 7 } }));
		const commandInput = (await screen.findByDisplayValue(/token=tok123/)) as HTMLInputElement;
		expect(commandInput.value).toContain("https://app.test/api/ai/bridge?token=tok123");
		expect(commandInput.value).toContain('--cmd "bunx @agentclientprotocol/claude-agent-acp"');
		// Status poll ran once on open — waiting by default.
		await waitFor(() =>
			expect(fns.endpointBridgeStatusFn).toHaveBeenCalledWith({ data: { id: 7 } }),
		);
		expect(screen.getByText(/waiting for the CLI/)).toBeTruthy();
		await user.click(screen.getByText("Copy command"));
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining("token=tok123"));
		expect(await screen.findByText("Copied")).toBeTruthy();
	});

	it("flips to connected and offline statuses from the poll", async () => {
		fns.endpointBridgeStatusFn.mockResolvedValueOnce({
			ok: true,
			data: { status: "connected", lastSeenAt: new Date() },
		} as never);
		const user = userEvent.setup();
		renderPage([bridgeEp]);
		await user.click(screen.getByText("Connect via bridge"));
		expect(await screen.findByText("bridge connected")).toBeTruthy();

		fns.endpointBridgeStatusFn.mockResolvedValueOnce({
			ok: true,
			data: { status: "offline", lastSeenAt: null },
		} as never);
		renderPage([{ ...bridgeEp, id: 9 }]);
		await user.click(screen.getAllByText("Connect via bridge")[1]!);
		expect(await screen.findByText("bridge offline")).toBeTruthy();
	});

	it("closes the bridge dialog via the Close button and via dismiss", async () => {
		const user = userEvent.setup();
		renderPage([bridgeEp]);
		await user.click(screen.getByText("Connect via bridge"));
		expect(await screen.findByText("Connect agent via bridge")).toBeTruthy();
		// Footer Close button → setBridge(null). ("Close" also matches the
		// dialog X's sr-only span — pick the actual button element.)
		const closeButton = screen.getAllByText("Close").find((el) => el instanceof HTMLButtonElement);
		expect(closeButton).toBeDefined();
		await user.click(closeButton!);
		await waitFor(() => expect(screen.queryByText("Connect agent via bridge")).toBeNull());

		// Reopen, then dismiss through onOpenChange (Escape).
		await user.click(screen.getByText("Connect via bridge"));
		expect(await screen.findByText("Connect agent via bridge")).toBeTruthy();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByText("Connect agent via bridge")).toBeNull());
	});

	it("treats a null transport as the ws default for bridge detection", () => {
		renderPage([{ ...bridgeEp, id: 11, name: "Null tx", transport: null }]);
		expect(screen.getByText("bridge")).toBeTruthy();
		expect(screen.getByText("Connect via bridge")).toBeTruthy();
	});

	it("drops mints that land after close or for a different endpoint", async () => {
		const user = userEvent.setup();
		type Mint = { ok: true; data: { command: string; expiresAt: Date } };
		let resolveA: ((v: Mint) => void) | undefined;
		let resolveB: ((v: Mint) => void) | undefined;
		fns.createBridgeLinkFn
			.mockImplementationOnce(() => new Promise<Mint>((res) => (resolveA = res)))
			.mockImplementationOnce(() => new Promise<Mint>((res) => (resolveB = res)));
		renderPage([bridgeEp, { ...bridgeEp, id: 9, name: "Other agent" }]);

		await user.click(screen.getAllByText("Connect via bridge")[0]!);
		await waitFor(() => expect(fns.createBridgeLinkFn).toHaveBeenCalledWith({ data: { id: 7 } }));
		const closeButton = () =>
			screen.getAllByText("Close").find((el) => el instanceof HTMLButtonElement)!;
		await user.click(closeButton());
		await waitFor(() => expect(screen.queryByText("Connect agent via bridge")).toBeNull());

		// Stale mint for id 7 while endpoint 9's dialog is open → prev.id !== id.
		await user.click(screen.getAllByText("Connect via bridge")[1]!);
		await waitFor(() => expect(fns.createBridgeLinkFn).toHaveBeenCalledWith({ data: { id: 9 } }));
		resolveA!({ ok: true, data: { command: "stale-7", expiresAt: new Date() } });
		// Endpoint 9's own mint still lands.
		resolveB!({ ok: true, data: { command: "fresh-9", expiresAt: new Date() } });
		expect(await screen.findByDisplayValue("fresh-9")).toBeTruthy();

		// Mint resolving after the dialog closed → prev === null.
		let resolveC: ((v: Mint) => void) | undefined;
		fns.createBridgeLinkFn.mockImplementationOnce(
			() => new Promise<Mint>((res) => (resolveC = res)),
		);
		await user.click(closeButton());
		await waitFor(() => expect(screen.queryByText("Connect agent via bridge")).toBeNull());
		await user.click(screen.getAllByText("Connect via bridge")[0]!);
		await user.click(closeButton());
		await waitFor(() => expect(screen.queryByText("Connect agent via bridge")).toBeNull());
		resolveC!({ ok: true, data: { command: "stale-7", expiresAt: new Date() } });
		await waitFor(() => expect(screen.queryByDisplayValue("stale-7")).toBeNull());
	});

	it(
		"keeps polling while open and tolerates failed or empty status reads",
		{ timeout: 15_000 },
		async () => {
			fns.endpointBridgeStatusFn
				.mockResolvedValueOnce({ ok: false } as never)
				.mockResolvedValueOnce({ ok: true, data: null } as never);
			const user = userEvent.setup();
			renderPage([bridgeEp]);
			await user.click(screen.getByText("Connect via bridge"));
			// Failed + null reads leave the badge on the waiting copy.
			expect(await screen.findByText(/waiting for the CLI/)).toBeTruthy();
			// The 3s interval keeps ticking while the dialog stays open.
			await waitFor(() => expect(fns.endpointBridgeStatusFn).toHaveBeenCalledTimes(3), {
				timeout: 10_000,
			});
		},
	);

	it("drops the in-flight status tick once the dialog closes", async () => {
		let resolveStatus:
			| ((v: { ok: true; data: { status: string; lastSeenAt: Date | null } }) => void)
			| undefined;
		fns.endpointBridgeStatusFn.mockImplementationOnce(
			() =>
				new Promise<{ ok: true; data: { status: string; lastSeenAt: Date | null } }>(
					(res) => (resolveStatus = res),
				),
		);
		const user = userEvent.setup();
		renderPage([bridgeEp]);
		await user.click(screen.getByText("Connect via bridge"));
		await waitFor(() => expect(fns.endpointBridgeStatusFn).toHaveBeenCalled());
		const closeButton = screen.getAllByText("Close").find((el) => el instanceof HTMLButtonElement)!;
		await user.click(closeButton);
		resolveStatus!({ ok: true, data: { status: "connected", lastSeenAt: new Date() } });
		// The stale tick short-circuits on `stopped` — no status lands.
		await waitFor(() => expect(screen.queryByText("bridge connected")).toBeNull());
	});

	it("omits the command box when the link mint fails", async () => {
		fns.createBridgeLinkFn.mockResolvedValueOnce({ ok: true, data: null } as never);
		const user = userEvent.setup();
		renderPage([bridgeEp]);
		await user.click(screen.getByText("Connect via bridge"));
		expect(await screen.findByText("Connect agent via bridge")).toBeTruthy();
		expect(screen.queryByDisplayValue(/token=/)).toBeNull();
		expect(screen.queryByText("Copy command")).toBeNull();
	});

	it("allows an empty baseUrl only for acp+ws — the bridge sentinel", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New endpoint"));
		const boxes = screen.getAllByRole("textbox");
		await user.type(boxes[0]!, "Bridge agent");
		// openai + empty baseUrl → save stays disabled.
		await user.clear(boxes[1]!);
		expect(screen.getByText("Save")).toHaveProperty("disabled", true);
		// acp+ws + empty baseUrl → the bridge hint shows and save unlocks.
		await user.click(screen.getByLabelText("Kind"));
		await user.click(await screen.findByRole("option", { name: "acp" }));
		expect(screen.getByText(/Leave empty on acp\+ws/)).toBeTruthy();
		expect(screen.getByText("Save")).toHaveProperty("disabled", false);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "Bridge agent",
			kind: "acp",
			baseUrl: "",
			transport: "ws",
		});
	});
});

describe("EndpointsPage — machine picker", () => {
	// Only id/name reach the DOM — the card shape is wider but the
	// select renders name text and submits the numeric id.
	const gpuBox = { id: 7, name: "gpu-box" };

	/** Open the endpoint dialog as acp+ssh — the only transport that
	 * reveals the machine <select> (child/ssh block). */
	const openAcpSsh = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(screen.getByText("New endpoint"));
		await user.type(screen.getAllByRole("textbox")[0]!, "ACP on gpu");
		await user.click(screen.getByLabelText("Kind"));
		await user.click(await screen.findByRole("option", { name: "acp" }));
		await user.click(screen.getByLabelText("Transport"));
		await user.click(await screen.findByRole("option", { name: "ssh" }));
	};

	const machineSelect = () =>
		screen.getByText("Machine").parentElement!.querySelector("select") as HTMLSelectElement;

	it("lists registry machines for non-ws acp transports and sends machineId", async () => {
		machineFns.machinesListFn.mockResolvedValueOnce([gpuBox]);
		const user = userEvent.setup();
		renderPage();
		await openAcpSsh(user);
		const select = machineSelect();
		await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
		expect(select.querySelector("option[value='7']")?.textContent).toBe("gpu-box");
		await user.selectOptions(select, "7");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "ACP on gpu",
			kind: "acp",
			transport: "ssh",
			machineId: 7,
		});
	});

	it("restores machineId when editing a machine-linked endpoint", async () => {
		const linked: EndpointCard = {
			...endpoint,
			kind: "acp",
			transport: "ssh",
			machineId: 7,
		};
		machineFns.machinesListFn.mockResolvedValueOnce([{ id: 7, name: "gpu-box" }]);
		const user = userEvent.setup();
		renderPage([linked]);
		await user.click(screen.getByText("Edit"));
		const select = machineSelect();
		await waitFor(() => expect(select.value).toBe("7"));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		expect(fns.saveEndpointFn.mock.calls[0]?.[0]?.data).toMatchObject({
			id: 2,
			machineId: 7,
		});
	});

	it("keeps the picker empty when the machines fetch rejects", async () => {
		machineFns.machinesListFn.mockRejectedValueOnce(new Error("machines down"));
		const user = userEvent.setup();
		renderPage();
		await openAcpSsh(user);
		await waitFor(() => expect(machineFns.machinesListFn).toHaveBeenCalled());
		const select = machineSelect();
		// Only the "—" empty option survives the rejected fetch.
		await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(1));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.saveEndpointFn).toHaveBeenCalled());
		const wire = fns.saveEndpointFn.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("machineId" in wire).toBe(false);
	});
});
