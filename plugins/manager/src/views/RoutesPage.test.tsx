// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RoutesPage, type RouteRow } from "./RoutesPage.tsx";

afterEach(cleanup);

const ROWS: readonly RouteRow[] = [
	{
		key: "patients.detail",
		path: "/patients/:id",
		params: ["id"],
		pluginId: "patients.routes",
	},
	{
		key: "pages.custom",
		path: "/*",
		context: "app",
		pluginId: "pages.render",
	},
];

describe("RoutesPage", () => {
	it("renders the registry header and every route row", () => {
		render(<RoutesPage routes={ROWS} />);
		expect(screen.getByText("Routes")).toBeTruthy();
		expect(screen.getByText("patients.detail")).toBeTruthy();
		expect(screen.getByText("/patients/:id")).toBeTruthy();
		expect(screen.getByText("pages.custom")).toBeTruthy();
		expect(screen.getByText("pages.render")).toBeTruthy();
		// Param names join into the params cell; absent params show the
		// muted placeholder.
		expect(screen.getByText("id")).toBeTruthy();
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("renders the empty state when no routes are registered", () => {
		render(<RoutesPage routes={[]} />);
		expect(screen.getByText("No routes registered.")).toBeTruthy();
	});
});
