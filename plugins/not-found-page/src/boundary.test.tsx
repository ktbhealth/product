// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { BoundaryContext } from "@ktb/kernel";

import { NotFoundPageBoundary } from "./boundary.tsx";

const ctx = (over: Partial<BoundaryContext> = {}): BoundaryContext => ({
	plugins: [],
	locale: "en",
	pathname: "/no/such/page",
	...over,
});

afterEach(cleanup);

describe("NotFoundPageBoundary", () => {
	it("renders the localized title and body", () => {
		render(createElement(NotFoundPageBoundary, { ctx: ctx() }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Page not found");
		expect(
			screen.getByText("The address does not exist or the page is not available to you."),
		).toBeTruthy();
	});

	it("resolves copy for the ctx locale", () => {
		render(createElement(NotFoundPageBoundary, { ctx: ctx({ locale: "pt-BR" }) }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Página não encontrada");
	});

	it("renders the host-provided actions row when present", () => {
		render(
			createElement(NotFoundPageBoundary, {
				ctx: ctx(),
				actions: createElement("a", { href: "/consultations" }, "Go to consultations"),
			}),
		);
		expect(screen.getByRole("link", { name: "Go to consultations" })).toBeTruthy();
	});

	it("still renders the surface when no actions are provided", () => {
		render(createElement(NotFoundPageBoundary, { ctx: ctx(), actions: undefined }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Page not found");
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("prefers DB slice messages over the code catalog", () => {
		render(
			createElement(NotFoundPageBoundary, {
				ctx: ctx({
					i18n: {
						locale: "en",
						catalog: { "not-found-page.title": "Nothing here" },
					},
				}),
			}),
		);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Nothing here");
	});
});
