// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import { DashboardPlatformPage } from "./platform-page.tsx";

describe("DashboardPlatformPage", () => {
	it("maps loader data and the panel ctx into the view", () => {
		render(
			<DashboardPlatformPage
				data={{ pluginStates: [{ pluginId: "a.b", enabled: true, system: false, config: null }] }}
				ctx={{ plugins: [], locale: "en", user: null }}
			/>,
		);
		expect(screen.getByText("Dashboard")).toBeTruthy();
		expect(screen.getByText("Plugins")).toBeTruthy();
	});
});
