// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	listPersonaDefsFn: vi.fn(async () => ({ ok: true, data: [] })),
	savePersonaDefFn: vi.fn(),
	deletePersonaDefFn: vi.fn(),
	generatePersonasFn: vi.fn(),
	listEndpointsFn: vi.fn(),
	listEndpointPresetsFn: vi.fn(async () => ({ ok: true, data: [] })),
	saveEndpointFn: vi.fn(),
	deleteEndpointFn: vi.fn(),
	testEndpointFn: vi.fn(),
	listInstancesFn: vi.fn(async () => ({ ok: true, data: [] })),
	instanceDetailFn: vi.fn(async () => ({ ok: true, data: null })),
	createInstanceFn: vi.fn(),
	startInstanceFn: vi.fn(),
	deleteInstanceFn: vi.fn(),
}));
vi.mock("@ktb/eval-credentials/fns", () => ({
	listCredentialsFn: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn() }),
}));

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
							batchId: null,
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
