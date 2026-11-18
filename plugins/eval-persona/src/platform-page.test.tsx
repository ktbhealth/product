// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	listPersonaDefsFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	savePersonaDefFn: vi.fn<() => Promise<unknown>>(),
	deletePersonaDefFn: vi.fn<() => Promise<unknown>>(),
	generatePersonasFn: vi.fn<() => Promise<unknown>>(),
	listInstancesFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
	instanceDetailFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: null })),
	createInstanceFn: vi.fn<() => Promise<unknown>>(),
	startInstanceFn: vi.fn<() => Promise<unknown>>(),
	deleteInstanceFn: vi.fn<() => Promise<unknown>>(),
	spawnInstancesFn: vi.fn<() => Promise<unknown>>(async () => ({
		ok: true,
		data: { created: 0 },
	})),
}));
vi.mock("@ktb/ai-provider/fns", () => ({
	listEndpointsFn: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: [] })),
}));
vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		useRouter: () => ({ invalidate: vi.fn<() => void>() }),
		// EvalSteps renders Link — degrade it to a plain anchor outside
		// a router.
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import type { PanelPageContext } from "@ktb/kernel";

import { InstancesPanelPage, PersonasPanelPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

afterEach(cleanup);

describe("eval-persona panel wrappers", () => {
	it("PersonasPanelPage passes defs through and narrows anything else", () => {
		render(
			<PersonasPanelPage
				data={[
					{
						id: 1,
						name: "idosa",
						persona: { name: "Maria" },
						notes: null,
						createdBy: null,
						createdAt: new Date(),
						updatedAt: null,
					},
				]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("idosa")).toBeTruthy();

		cleanup();
		render(<PersonasPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No personas yet/)).toBeTruthy();
	});

	it("InstancesPanelPage narrows the loader object", () => {
		render(
			<InstancesPanelPage
				data={{
					instances: [
						{
							id: 1,
							name: "lote",
							mode: "random",
							endpointId: null,
							endpointName: null,
							params: {},
							status: "draft",
							total: 2,
							done: 0,
							createdBy: null,
							createdAt: new Date(),
						},
					],
					defs: [],
					endpoints: [],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("lote")).toBeTruthy();

		cleanup();
		render(<InstancesPanelPage data={42} ctx={ctx} />);
		expect(screen.getByText(/No instances yet/)).toBeTruthy();
	});
});
