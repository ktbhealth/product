// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => Promise<void>>(async () => {}) }),
}));

type FnMock = (arg: { data: unknown }) => Promise<unknown>;
const fns = vi.hoisted(() => ({
	i18nSetLocaleFn: vi.fn<FnMock>(async () => ({ ok: true })),
}));
vi.mock("../fns.ts", () => fns);

import type { LocalesPageData } from "./LocalesPage.tsx";
import { LocalesPage } from "./LocalesPage.tsx";

const data: LocalesPageData = {
	locales: [
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "fr", endonym: "Français", fallbacks: ["en"], enabled: false },
		{ code: "qps", endonym: "Pseudo", fallbacks: [], enabled: false },
	],
};

beforeEach(() => {
	Object.values(fns).forEach((fn) => fn.mockClear());
	fns.i18nSetLocaleFn.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("LocalesPage", () => {
	it("renders every locale with code, fallbacks and status", async () => {
		render(<LocalesPage data={data} />);
		expect(await screen.findByText("English")).toBeTruthy();
		expect(screen.getByText("pt-BR")).toBeTruthy();
		expect(screen.getAllByText("en").length).toBeGreaterThan(0);
		expect(screen.getAllByText("disabled").length).toBe(2);
	});

	it("shows an empty state with no locales", async () => {
		render(<LocalesPage data={{ locales: [] }} />);
		expect(await screen.findByText("No locales configured.")).toBeTruthy();
	});

	it("toggles a locale through i18nSetLocaleFn", async () => {
		const user = userEvent.setup();
		render(<LocalesPage data={data} />);
		await screen.findByText("English");
		await user.click(screen.getByLabelText("Toggle locale fr"));
		await waitFor(() =>
			expect(fns.i18nSetLocaleFn).toHaveBeenCalledWith({ data: { code: "fr", enabled: true } }),
		);
		expect(await screen.findByText("fr enabled.")).toBeTruthy();
	});

	it("toggles locales both ways and surfaces bare denials", async () => {
		fns.i18nSetLocaleFn
			.mockResolvedValueOnce({ ok: false, error: "nope" })
			.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<LocalesPage data={data} />);
		await screen.findByText("English");
		await user.click(screen.getByLabelText("Toggle locale fr"));
		expect(await screen.findByText("nope")).toBeTruthy();
		// A bare { ok:false } falls back to the generic denial text.
		await user.click(screen.getByLabelText("Toggle locale en"));
		expect(await screen.findByText("denied toggling en")).toBeTruthy();
		// Successful disable reports the new state.
		await user.click(screen.getByLabelText("Toggle locale en"));
		expect(await screen.findByText("en disabled.")).toBeTruthy();
	});
});
