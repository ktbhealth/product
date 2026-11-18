// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	listAgentLinksFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	revokeAgentLinkFn: vi.fn<(a?: Arg) => Res<{ revoked: boolean }>>(async () => ({
		ok: true,
		data: { revoked: true },
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
}));
vi.mock("../fns.ts", () => fns);
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { AgentLinkRow, EndpointCard } from "../index.ts";
import { AgentsPage } from "./AgentsPage.tsx";

const bridgeEp: EndpointCard = {
	id: 7,
	name: "Local agent",
	kind: "acp",
	baseUrl: "",
	model: null,
	sessionId: null,
	secretRef: null,
	transport: "ws",
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

const remoteEp: EndpointCard = {
	...bridgeEp,
	id: 9,
	name: "OpenAI prod",
	kind: "openai",
	baseUrl: "https://api.example/v1",
	transport: null,
};

const link = (over: Partial<AgentLinkRow>): AgentLinkRow => ({
	id: 1,
	endpointId: 7,
	endpointName: "Local agent",
	status: "waiting",
	createdAt: new Date(Date.now() - 30_000),
	expiresAt: new Date(Date.now() + 15 * 60_000),
	usedAt: null,
	lastSeenAt: null,
	...over,
});

const renderPage = (
	links: readonly AgentLinkRow[] = [],
	endpoints: readonly EndpointCard[] = [bridgeEp],
) => render(<AgentsPage links={links} endpoints={endpoints} locale="en" />);

afterEach(cleanup);

describe("AgentsPage", () => {
	it("renders the empty state", () => {
		renderPage();
		expect(screen.getByText(/No agent links/)).toBeTruthy();
	});

	it("renders one badge per state and hides revoke on terminal rows", () => {
		renderPage([
			link({ id: 1, status: "waiting" }),
			link({ id: 2, status: "connected", usedAt: new Date(), lastSeenAt: new Date() }),
			link({
				id: 3,
				status: "offline",
				usedAt: new Date(Date.now() - 3_600_000),
				lastSeenAt: new Date(Date.now() - 3_600_000),
			}),
			link({ id: 4, status: "expired", expiresAt: new Date(Date.now() - 3_600_000) }),
			link({ id: 5, status: "revoked", createdAt: new Date(Date.now() - 3 * 86_400_000) }),
			// Wire timestamps may arrive as ISO strings; garbage narrows to —.
			link({ id: 6, status: "waiting", createdAt: "not-a-date" as never }),
			link({ id: 7, status: "waiting", lastSeenAt: "2026-01-01T00:00:00Z" as never }),
		]);
		for (const s of ["connected", "offline", "expired", "revoked"]) {
			expect(screen.getByText(s)).toBeTruthy();
		}
		// Three waiting rows share the badge text.
		expect(screen.getAllByText("waiting")).toHaveLength(3);
		// Relative timestamps: minutes (expires), hours (last seen),
		// days (old created), em dash for nulls.
		expect(screen.getAllByText(/minute/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/hour/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/day/).length).toBeGreaterThan(0);
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
		// Only the five live rows carry a revoke action.
		expect(screen.getAllByText("Revoke")).toHaveLength(5);
	});

	it("mints a link for the picked bridge endpoint and shows the command once", async () => {
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, "writeText");
		// Non-bridge shapes are filtered out: openai, acp+ws WITH a URL,
		// acp+child, and a disabled bridge endpoint. A null transport
		// counts as ws — "Null tx" stays selectable.
		renderPage(
			[],
			[
				bridgeEp,
				remoteEp,
				{ ...bridgeEp, id: 10, name: "Remote ACP", baseUrl: "ws://h" },
				{ ...bridgeEp, id: 11, name: "Child ACP", transport: "child", agentCmd: "cat" },
				{ ...bridgeEp, id: 12, name: "Off agent", enabled: false },
				{ ...bridgeEp, id: 13, name: "Null tx", transport: null },
			],
		);
		await user.click(screen.getByText("New link"));
		// Only bridge endpoints are selectable — the openai row is absent.
		await user.click(screen.getByLabelText("Bridge endpoint"));
		expect(screen.queryByRole("option", { name: "OpenAI prod" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Remote ACP" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Child ACP" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Off agent" })).toBeNull();
		expect(await screen.findByRole("option", { name: "Null tx" })).toBeTruthy();
		await user.click(await screen.findByRole("option", { name: "Local agent" }));
		await user.click(screen.getByText("Create link"));
		await waitFor(() => expect(fns.createBridgeLinkFn).toHaveBeenCalledWith({ data: { id: 7 } }));
		const commandInput = (await screen.findByDisplayValue(/token=tok123/)) as HTMLInputElement;
		expect(commandInput.value).toContain("https://app.test/api/ai/bridge?token=tok123");
		expect(screen.getByText(/shown once/)).toBeTruthy();
		await user.click(screen.getByText("Copy command"));
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining("token=tok123"));
		expect(await screen.findByText("Copied")).toBeTruthy();
		// The minted row refetches through the poll path.
		expect(fns.listAgentLinksFn).toHaveBeenCalled();
	});

	it("keeps the picker without a selection and closes via Escape", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New link"));
		// Create stays disabled until an endpoint is picked.
		expect(screen.getByText("Create link")).toHaveProperty("disabled", true);
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("explains when no bridge endpoint exists", async () => {
		const user = userEvent.setup();
		renderPage([], [remoteEp]);
		await user.click(screen.getByText("New link"));
		expect(await screen.findByText(/No bridge endpoints/)).toBeTruthy();
		expect(screen.getByText("Create link")).toHaveProperty("disabled", true);
	});

	it("surfaces the failure when the mint is denied", async () => {
		fns.createBridgeLinkFn.mockResolvedValueOnce({ ok: true, data: null } as never);
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New link"));
		await user.click(screen.getByLabelText("Bridge endpoint"));
		await user.click(await screen.findByRole("option", { name: "Local agent" }));
		await user.click(screen.getByText("Create link"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("drops a mint that resolves after the dialog closed", async () => {
		type Mint = { ok: true; data: { command: string; expiresAt: Date } };
		let resolveMint: ((v: Mint) => void) | undefined;
		fns.createBridgeLinkFn.mockImplementationOnce(
			() => new Promise<Mint>((res) => (resolveMint = res)),
		);
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByText("New link"));
		await user.click(screen.getByLabelText("Bridge endpoint"));
		await user.click(await screen.findByRole("option", { name: "Local agent" }));
		await user.click(screen.getByText("Create link"));
		const closeButton = screen.getAllByText("Close").find((el) => el instanceof HTMLButtonElement)!;
		await user.click(closeButton);
		resolveMint!({ ok: true, data: { command: "stale", expiresAt: new Date() } });
		await waitFor(() => expect(screen.queryByDisplayValue("stale")).toBeNull());
	});

	it("revokes a link through the confirm dialog and refetches", async () => {
		const user = userEvent.setup();
		// The mount poll must echo the rendered row — a [] answer would
		// empty the table mid-interaction.
		fns.listAgentLinksFn
			.mockResolvedValueOnce({ ok: true, data: [link({})] })
			.mockResolvedValue({ ok: true, data: [link({ status: "revoked" })] });
		renderPage([link({})]);
		await user.click(screen.getByText("Revoke"));
		expect(await screen.findByText("Revoke link")).toBeTruthy();
		await user.click(screen.getByText("Confirm revoke"));
		await waitFor(() => expect(fns.revokeAgentLinkFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		// The refetched list shows the revoked badge.
		expect(await screen.findByText("revoked")).toBeTruthy();
	});

	it("surfaces the failure when revoke is denied", async () => {
		fns.revokeAgentLinkFn.mockResolvedValueOnce({ ok: false } as never);
		fns.listAgentLinksFn.mockResolvedValue({ ok: true, data: [link({})] });
		const user = userEvent.setup();
		renderPage([link({})]);
		await user.click(screen.getByText("Revoke"));
		await user.click(await screen.findByText("Confirm revoke"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("refetches on the 10s poll so waiting flips to connected", async () => {
		vi.useFakeTimers();
		try {
			fns.listAgentLinksFn.mockResolvedValue({ ok: true, data: [link({})] });
			renderPage();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(screen.getByText("waiting")).toBeTruthy();
			fns.listAgentLinksFn.mockResolvedValue({
				ok: true,
				data: [link({ status: "connected", usedAt: new Date(), lastSeenAt: new Date() })],
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(screen.getByText("connected")).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops the in-flight poll once unmounted", async () => {
		let resolvePoll: ((v: { ok: true; data: readonly unknown[] }) => void) | undefined;
		fns.listAgentLinksFn.mockImplementationOnce(
			() => new Promise<{ ok: true; data: readonly unknown[] }>((res) => (resolvePoll = res)),
		);
		const { unmount } = renderPage();
		unmount();
		resolvePoll!({ ok: true, data: [link({})] });
		// The stopped flag short-circuits — only the mount-time call ran.
		expect(fns.listAgentLinksFn).toHaveBeenCalledTimes(1);
	});
});
