// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationListRow } from "../fns.ts";

// The editor/list views only need anchors — no router context in tests.
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		asChild: _asChild,
		...rest
	}: {
		to: string;
		children: React.ReactNode;
		asChild?: boolean;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));

import { PipelinesPage } from "./PipelinesPage.tsx";

const rows: OrchestrationListRow[] = [
	{
		id: "demo",
		version: "2",
		description: "demo def",
		nodeCount: 3,
		enabled: true,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
	},
	{ id: "minimal", version: "1", nodeCount: 0, enabled: true, createdAt: 1, updatedAt: 2 },
];

afterEach(cleanup);

describe("PipelinesPage", () => {
	it("renders the def table with links into the editor", () => {
		render(<PipelinesPage rows={rows} locale="en" />);
		expect(screen.getByText("Pipelines")).toBeTruthy();
		const link = screen.getByRole("link", { name: "demo" });
		expect(link.getAttribute("href")).toBe("/platform/pipelines/demo");
		// Button render={<Link>} keeps button semantics (role="button")
		// while rendering the anchor — see views/ViewPage.test.tsx.
		expect(screen.getByRole("button", { name: /New pipeline/ }).getAttribute("href")).toBe(
			"/platform/pipelines/new",
		);
		expect(screen.getByText("demo def")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
	});

	it("renders the empty state when no defs are stored", () => {
		render(<PipelinesPage rows={[]} locale="en" />);
		expect(screen.getByText("No orchestration defs stored yet.")).toBeTruthy();
	});
});
