// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type FnMock = (arg: { data: unknown }) => Promise<unknown>;

const h = vi.hoisted(() => ({
	navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => Promise<void>>(async () => {}) }),
	useNavigate: () => h.navigate,
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

import {
	I18nDraftsPlatformPage,
	I18nIndexRedirect,
	I18nLocalesPlatformPage,
	I18nNamespacesPlatformPage,
	I18nPlatformPage,
} from "./platform-page.tsx";

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
		expect(await screen.findByText("Messages")).toBeTruthy();
		expect(screen.getByText("English")).toBeTruthy();
	});

	it("tolerates missing or malformed loader data", async () => {
		render(<I18nPlatformPage ctx={ctx} data={null} />);
		expect(await screen.findByText("Messages")).toBeTruthy();
		cleanup();
		render(<I18nPlatformPage ctx={ctx} data={{ namespaces: "nope", locales: 42 }} />);
		expect(await screen.findByText("Messages")).toBeTruthy();
	});
});

describe("I18nLocalesPlatformPage", () => {
	it("renders locales from loader data and tolerates malformed data", async () => {
		render(
			<I18nLocalesPlatformPage
				ctx={ctx}
				data={{ locales: [{ code: "en", endonym: "English", fallbacks: [], enabled: true }] }}
			/>,
		);
		expect(await screen.findByText("Locales")).toBeTruthy();
		expect(screen.getByText("English")).toBeTruthy();
		cleanup();
		render(<I18nLocalesPlatformPage ctx={ctx} data={null} />);
		expect(await screen.findByText("Locales")).toBeTruthy();
		cleanup();
		render(<I18nLocalesPlatformPage ctx={ctx} data={{ locales: 42 }} />);
		expect(await screen.findByText("Locales")).toBeTruthy();
	});
});

describe("I18nDraftsPlatformPage", () => {
	it("renders drafts from loader data and tolerates malformed data", async () => {
		render(
			<I18nDraftsPlatformPage
				ctx={ctx}
				data={{
					drafts: [
						{
							namespace: "app",
							key: "title",
							locale: "en",
							scope: "global",
							scopeId: "",
							kind: "text",
							value: "Hello",
							draftValue: "Hi",
							status: "published",
							params: [],
							version: 1,
							createdAt: new Date(0),
							updatedAt: new Date(0),
						},
					],
					locales: [{ code: "en", endonym: "English", fallbacks: [], enabled: true }],
				}}
			/>,
		);
		expect(await screen.findByText("Pending drafts")).toBeTruthy();
		expect(screen.getByText("Hi")).toBeTruthy();
		cleanup();
		render(<I18nDraftsPlatformPage ctx={ctx} data={{ drafts: "nope", locales: 42 }} />);
		expect(await screen.findByText("No pending drafts.")).toBeTruthy();
	});
});

describe("I18nNamespacesPlatformPage", () => {
	it("renders coverage from loader data and tolerates malformed data", async () => {
		render(
			<I18nNamespacesPlatformPage
				ctx={ctx}
				data={{
					namespaces: [{ namespace: "app", pluginId: "app", defaultLocale: "en", messageCount: 2 }],
					coverage: [
						{
							namespace: "app",
							pluginId: "app",
							defaultLocale: "en",
							keyCount: 2,
							translated: { en: 2 },
							manifestHash: "",
							manifestDrift: "unrecorded",
						},
					],
					locales: [{ code: "en", endonym: "English", fallbacks: [], enabled: true }],
				}}
			/>,
		);
		expect(await screen.findByText("Namespaces")).toBeTruthy();
		expect(screen.getAllByText("app").length).toBeGreaterThan(0);
		expect(screen.getByText(/2\/2/)).toBeTruthy();
		cleanup();
		render(
			<I18nNamespacesPlatformPage
				ctx={ctx}
				data={{ namespaces: 1, coverage: "x", locales: null }}
			/>,
		);
		expect(await screen.findByText("No namespaces registered.")).toBeTruthy();
	});
});

describe("I18nIndexRedirect", () => {
	it("navigates to /platform/i18n/messages on mount", async () => {
		h.navigate.mockClear();
		render(<I18nIndexRedirect ctx={ctx} data={null} />);
		await waitFor(() =>
			expect(h.navigate).toHaveBeenCalledWith({
				to: "/platform/i18n/messages",
				replace: true,
			}),
		);
	});
});
