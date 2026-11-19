// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

import { QueuePlatformPage } from "./platform-page.tsx";

vi.mock("./views/QueuePage.tsx", () => ({
	QueuePage: (props: Record<string, unknown>) => (
		<div data-testid="queue-page">{JSON.stringify(props)}</div>
	),
}));

const ctx = (locale = "en") =>
	({ plugins: [], locale, i18n: undefined }) as unknown as PanelPageContext;

const viewProps = () =>
	JSON.parse(screen.getByTestId("queue-page").textContent ?? "{}") as Record<string, unknown>;

afterEach(cleanup);

describe("QueuePlatformPage", () => {
	it("narrows loader data into view props", () => {
		render(
			<QueuePlatformPage
				data={{
					queues: [{ id: "jobs", name: "ktb:jobs" }],
					runs: [{ id: "run-1", kind: "jobs.ping" }],
					kinds: ["jobs.ping"],
				}}
				ctx={ctx("pt-BR")}
			/>,
		);
		expect(viewProps()).toMatchObject({
			queues: [{ id: "jobs", name: "ktb:jobs" }],
			runs: [{ id: "run-1", kind: "jobs.ping" }],
			kinds: ["jobs.ping"],
			locale: "pt-BR",
		});
	});

	it("degrades missing loader data to null props", () => {
		render(<QueuePlatformPage data={undefined} ctx={ctx()} />);
		expect(viewProps()).toMatchObject({
			queues: null,
			runs: null,
			kinds: null,
			locale: "en",
		});
	});
});
