// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	listEndpointsFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	listEndpointPresetsFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	saveEndpointFn: vi.fn<() => Promise<unknown>>(),
	deleteEndpointFn: vi.fn<() => Promise<unknown>>(),
	testEndpointFn: vi.fn<() => Promise<unknown>>(),
	listAgentLinksFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	revokeAgentLinkFn: vi.fn<() => Promise<unknown>>(),
	createBridgeLinkFn: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@ktb/credentials/fns", () => ({
	listCredentialsFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { AgentsPanelPage, EndpointsPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

afterEach(cleanup);

describe("ai-endpoints panel wrapper", () => {
	it("EndpointsPanelPage passes cards through and narrows anything else", () => {
		render(
			<EndpointsPanelPage
				data={[
					{
						id: 1,
						name: "Ollama",
						kind: "openai",
						baseUrl: "http://localhost:11434/v1",
						model: "qwen",
						sessionId: null,
						secretRef: null,
						transport: null,
						scope: "eval",
						isDefault: false,
						timeoutMs: 60_000,
						enabled: true,
						createdAt: new Date(),
					},
				]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Ollama")).toBeTruthy();

		cleanup();
		render(<EndpointsPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No endpoints/)).toBeTruthy();
	});

	it("AgentsPanelPage unpacks {links, endpoints} and narrows anything else", () => {
		render(
			<AgentsPanelPage
				data={{
					links: [
						{
							id: 3,
							endpointId: 7,
							endpointName: "Local agent",
							status: "waiting",
							createdAt: new Date(),
							expiresAt: new Date(Date.now() + 60_000),
							usedAt: null,
							lastSeenAt: null,
						},
					],
					endpoints: [],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Local agent")).toBeTruthy();
		expect(screen.getByText("waiting")).toBeTruthy();

		cleanup();
		render(<AgentsPanelPage data={42} ctx={ctx} />);
		expect(screen.getByText(/No agent links/)).toBeTruthy();
	});
});
