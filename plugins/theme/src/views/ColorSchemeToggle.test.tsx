// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { THEME_SCHEME_COOKIE } from "../types.ts";
import { ColorSchemeToggle } from "./ColorSchemeToggle.tsx";

const clearSchemeCookie = () => {
	document.cookie = `${THEME_SCHEME_COOKIE}=; path=/; max-age=0`;
};

afterEach(() => {
	cleanup();
	document.documentElement.classList.remove("dark");
	clearSchemeCookie();
});

describe("ColorSchemeToggle", () => {
	it("reflects the persisted scheme in the trigger label", async () => {
		document.cookie = `${THEME_SCHEME_COOKIE}=light; path=/`;
		render(<ColorSchemeToggle locale="en" />);
		expect(await screen.findByRole("button", { name: "Appearance: Light" })).toBeTruthy();
	});

	it("writes the cookie and applies .dark when a scheme is picked", async () => {
		const user = userEvent.setup();
		render(<ColorSchemeToggle locale="en" />);
		// No cookie → the effect resolves to "system".
		const trigger = await screen.findByRole("button", { name: "Appearance: System" });
		await user.click(trigger);

		await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
		expect(document.cookie).toContain(`${THEME_SCHEME_COOKIE}=dark`);
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(await screen.findByRole("button", { name: "Appearance: Dark" })).toBeTruthy();
	});
});
