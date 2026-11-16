// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	setThemePreviewFn: vi.fn(),
}));

vi.mock("../fns.ts", () => ({
	setThemePreviewFn: fns.setThemePreviewFn,
}));

import { ThemePreviewBanner } from "./ThemePreviewBanner.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	fns.setThemePreviewFn.mockReset();
});

describe("ThemePreviewBanner", () => {
	it("renders the preview notice and exits through the server fn", async () => {
		const reload = vi.fn();
		vi.stubGlobal("location", { reload });
		let resolveFn: (() => void) | undefined;
		fns.setThemePreviewFn.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveFn = resolve;
				}),
		);
		render(<ThemePreviewBanner locale="en" />);
		expect(screen.getByText("Theme preview active")).toBeTruthy();
		const button = screen.getByRole("button", { name: /Exit preview/ });
		await userEvent.click(button);
		expect(fns.setThemePreviewFn).toHaveBeenCalledWith({ data: { themeId: null } });
		// Still busy while the fn is in flight.
		expect((button as HTMLButtonElement).disabled).toBe(true);
		await act(async () => resolveFn?.());
		expect(reload).toHaveBeenCalled();
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it("defaults to the en locale", () => {
		render(<ThemePreviewBanner />);
		expect(screen.getByText("Theme preview active")).toBeTruthy();
	});
});
