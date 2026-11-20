// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
	useLocation: () => ({ state: { key: "k" } }),
	useSearch: () => ({}),
}));

vi.mock("./fns.ts", () => ({
	listImagesFn: vi.fn<() => Promise<unknown>>(),
	updateImageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteImageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	imageUsageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { ImageAdminConsolePage } from "./platform-page.tsx";
import { listImagesFn } from "./fns.ts";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	title: "Pic",
	alt: "alt",
	mime: "image/png",
	size: 10,
	width: 2,
	height: 3,
	createdAt: new Date().toISOString(),
	src: "/api/images/1",
	...over,
});

afterEach(() => {
	cleanup();
	vi.mocked(listImagesFn).mockReset();
});

describe("ImageAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<ImageAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Images")).toBeTruthy();
		expect(screen.getByText("No images yet")).toBeTruthy();
	});

	it("narrows loader rows into the admin view", () => {
		render(<ImageAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getAllByText("Pic").length).toBeGreaterThan(0);
	});

	it("drops malformed rows and survives non-array data", () => {
		render(
			<ImageAdminConsolePage
				data={[row({}), { nope: true }, "x", null, row({ id: 2, src: 5 })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("Pic")).toHaveLength(1);
		cleanup();
		render(<ImageAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No images yet")).toBeTruthy();
	});
});
