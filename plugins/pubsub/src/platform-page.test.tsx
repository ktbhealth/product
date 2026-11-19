// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

import { PubSubPlatformPage } from "./platform-page.tsx";

vi.mock("./views/PubSubPage.tsx", () => ({
	PubSubPage: ({ topics, locale }: { topics: unknown; locale: string }) => (
		<div data-testid="pubsub-page">
			{locale}:{Array.isArray(topics) ? topics.length : "null"}
		</div>
	),
}));

const ctx = (locale = "en") => ({ locale, i18n: undefined }) as unknown as PanelPageContext;

afterEach(cleanup);

describe("PubSubPlatformPage", () => {
	it("narrows loader data into view props", () => {
		render(<PubSubPlatformPage data={{ topics: [{ id: "memory:x" }] }} ctx={ctx("pt-BR")} />);
		expect(screen.getByTestId("pubsub-page").textContent).toBe("pt-BR:1");
	});

	it("degrades missing sections to null", () => {
		render(<PubSubPlatformPage data={undefined} ctx={ctx()} />);
		expect(screen.getByTestId("pubsub-page").textContent).toBe("en:null");
	});
});
