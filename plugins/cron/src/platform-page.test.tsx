// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

import { CronPlatformPage } from "./platform-page.tsx";

vi.mock("./views/CronPage.tsx", () => ({
	CronPage: ({ runs, entries, locale }: { runs: unknown; entries: unknown; locale: string }) => (
		<div data-testid="cron-page">
			{locale}:{Array.isArray(entries) ? entries.length : "null"}:
			{Array.isArray(runs) ? runs.length : "null"}
		</div>
	),
}));

const ctx = (locale = "en") => ({ locale, i18n: undefined }) as unknown as PanelPageContext;

afterEach(cleanup);

describe("CronPlatformPage", () => {
	it("narrows loader data into view props", () => {
		render(
			<CronPlatformPage data={{ entries: [{ id: "cron:a" }], runs: [] }} ctx={ctx("pt-BR")} />,
		);
		expect(screen.getByTestId("cron-page").textContent).toBe("pt-BR:1:0");
	});

	it("degrades missing sections to null", () => {
		render(<CronPlatformPage data={undefined} ctx={ctx()} />);
		expect(screen.getByTestId("cron-page").textContent).toBe("en:null:null");
	});
});
