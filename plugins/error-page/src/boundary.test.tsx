// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoundaryContext } from "@ktb/kernel";

import { ErrorPageBoundary } from "./boundary.tsx";

const ctx = (over: Partial<BoundaryContext> = {}): BoundaryContext => ({
	plugins: [],
	locale: "en",
	pathname: "/broken",
	...over,
});

const renderBoundary = (
	over: Partial<Parameters<typeof ErrorPageBoundary>[0]> = {},
	ctxOver: Partial<BoundaryContext> = {},
) =>
	render(
		<ErrorPageBoundary
			ctx={ctx(ctxOver)}
			error={new Error("secret stack trace")}
			reset={vi.fn()}
			{...over}
		/>,
	);

afterEach(cleanup);

describe("ErrorPageBoundary", () => {
	it("renders the localized title and body", () => {
		renderBoundary();
		expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
		expect(screen.getByText("An unexpected error occurred. You can try again.")).toBeTruthy();
	});

	it("localizes copy from ctx.locale", () => {
		renderBoundary({}, { locale: "pt-BR" });
		expect(screen.getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
	});

	it("lets the DB i18n slice override copy", () => {
		renderBoundary({}, { i18n: { locale: "en", catalog: { "error-page.title": "DB Title" } } });
		expect(screen.getByRole("heading", { name: "DB Title" })).toBeTruthy();
	});

	it("never renders the error value or a stack trace", () => {
		const { container } = renderBoundary();
		expect(container.textContent).not.toContain("secret stack trace");
		expect(container.textContent).not.toContain("Error:");
	});

	it("calls reset when the retry button is clicked", () => {
		const reset = vi.fn();
		renderBoundary({ reset });
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it("renders host-provided actions inside the CTA row", () => {
		renderBoundary({ actions: <a href="/consultations">Go home</a> });
		expect(screen.getByRole("link", { name: "Go home" })).toBeTruthy();
	});

	it("omits the actions slot when the host provides none", () => {
		const { container } = renderBoundary({ actions: undefined });
		expect(container.querySelector("a")).toBeNull();
	});
});
