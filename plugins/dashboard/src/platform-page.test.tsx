// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

import { DashboardPlatformPage } from "./platform-page.tsx";

const ctx = (over: Partial<PanelPageContext> = {}): PanelPageContext =>
	({ locale: "en", plugins: [], ...over }) as PanelPageContext;

const data = { patients: [], consultations: [] };

afterEach(cleanup);

describe("DashboardPlatformPage", () => {
	it("narrows data+ctx into the view props", () => {
		render(<DashboardPlatformPage data={data} ctx={ctx()} />);
		expect(screen.getByText("dashboard")).toBeTruthy();
		expect(screen.getByText("Patients")).toBeTruthy();
	});
});
