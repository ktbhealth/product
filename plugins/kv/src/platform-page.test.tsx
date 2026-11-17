// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fns.ts", () => ({
	kvListFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvNamespacesFn: vi.fn<() => Promise<unknown>>(),
	kvGetFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvSetFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	kvDeleteFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { KvAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const entry = (over: Record<string, unknown> = {}) => ({
	namespace: "alpha",
	key: "k1",
	tenantId: null,
	ownerId: null,
	value: 1,
	version: 1,
	expiresAt: null,
	expired: false,
	...over,
});

afterEach(cleanup);

describe("KvAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<KvAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Key-value store")).toBeTruthy();
		expect(screen.getByText("No entries found")).toBeTruthy();
	});

	it("narrows loader data into the admin view", () => {
		render(
			<KvAdminConsolePage
				data={{
					items: [entry({})],
					total: 1,
					namespaces: [{ namespace: "alpha", count: 1 }],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("k1")).toBeTruthy();
		expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
		expect(screen.getByText("Global")).toBeTruthy();
		expect(screen.getByText("1 entry")).toBeTruthy();
	});

	it("drops malformed rows and survives non-object data", () => {
		render(
			<KvAdminConsolePage
				data={{
					items: [entry({}), { nope: true }, "x", null, entry({ key: "k2" })],
					total: "bad",
					namespaces: [{ namespace: "alpha", count: 1 }, { bad: true }, 7],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("alpha").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("k1")).toBeTruthy();
		expect(screen.getByText("k2")).toBeTruthy();
		cleanup();
		render(<KvAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No entries found")).toBeTruthy();
	});

	it("localizes through ctx.locale", () => {
		render(<KvAdminConsolePage data={undefined} ctx={{ ...ctx, locale: "pt-BR" }} />);
		expect(screen.getByText("Armazenamento chave-valor")).toBeTruthy();
	});
});
