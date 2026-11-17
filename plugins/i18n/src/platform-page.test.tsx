// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type FnMock = (arg: { data: unknown }) => Promise<unknown>;

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => Promise<void>>(async () => {}) }),
}));

vi.mock("./fns.ts", () => ({
	i18nDiscardDraftFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nExportFn: vi.fn<FnMock>(async () => null),
	i18nImportFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nNamespaceMessagesFn: vi.fn<FnMock>(async () => []),
	i18nPublishFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nSaveDraftFn: vi.fn<FnMock>(async () => ({ ok: true })),
	i18nSetLocaleFn: vi.fn<FnMock>(async () => ({ ok: true })),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { I18nPlatformPage } from "./platform-page.tsx";

const ctx = {} as PanelPageContext;

afterEach(cleanup);

describe("I18nPlatformPage", () => {
	it("renders the page with loader data", async () => {
		render(
			<I18nPlatformPage
				ctx={ctx}
				data={{
					namespaces: [{ namespace: "app", pluginId: "app", defaultLocale: "en", messageCount: 0 }],
					locales: [{ code: "en", endonym: "English", fallbacks: [], enabled: true }],
				}}
			/>,
		);
		expect(await screen.findByText("Translations")).toBeTruthy();
		expect(screen.getByText("Locales")).toBeTruthy();
	});

	it("tolerates missing or malformed loader data", async () => {
		render(<I18nPlatformPage ctx={ctx} data={null} />);
		expect(await screen.findByText("Translations")).toBeTruthy();
		cleanup();
		render(<I18nPlatformPage ctx={ctx} data={{ namespaces: "nope", locales: 42 }} />);
		expect(await screen.findByText("Translations")).toBeTruthy();
	});
});
