// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChromeProps } from "@ktb/kernel";

import { SiteLocaleToggle } from "./chrome.tsx";

const props = (over: Partial<ChromeProps> = {}): ChromeProps => ({
	user: null,
	locale: "en",
	plugins: [],
	locales: ["en", "es"],
	localeName: (l) => l.toUpperCase(),
	setLocale: vi.fn(),
	labels: {},
	signOut: vi.fn(async () => {}),
	...over,
});

afterEach(cleanup);

describe("SiteLocaleToggle", () => {
	it("renders the language menu with the host-provided label", () => {
		render(<SiteLocaleToggle {...props({ labels: { langMenu: "Idioma" } })} />);
		expect(screen.getByRole("button", { name: "Idioma" })).toBeTruthy();
	});

	it("falls back to English when the host fills no label", () => {
		render(<SiteLocaleToggle {...props()} />);
		expect(screen.getByRole("button", { name: "Language" })).toBeTruthy();
	});
});
