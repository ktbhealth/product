// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDateTime } from "./LocalDateTime.tsx";

afterEach(cleanup);

const WHEN = new Date("2026-03-04T15:30:00Z");

describe("LocalDateTime (client)", () => {
	it("renders a Date via toLocaleString(locale)", () => {
		render(<LocalDateTime value={WHEN} locale="en-US" />);
		expect(screen.getByText(WHEN.toLocaleString("en-US"))).toBeTruthy();
	});

	it("accepts epoch ms and date strings", () => {
		const { container, rerender } = render(<LocalDateTime value={WHEN.getTime()} locale="en-US" />);
		expect(container.textContent).toBe(WHEN.toLocaleString("en-US"));
		rerender(<LocalDateTime value={WHEN.toISOString()} locale="en-US" />);
		expect(container.textContent).toBe(WHEN.toLocaleString("en-US"));
	});

	it("forwards Intl options", () => {
		render(
			<LocalDateTime value={WHEN} locale="en-US" options={{ year: "numeric", month: "short" }} />,
		);
		expect(
			screen.getByText(WHEN.toLocaleString("en-US", { year: "numeric", month: "short" })),
		).toBeTruthy();
	});

	it("renders nothing for nullish values by default", () => {
		const { container, rerender } = render(<LocalDateTime value={null} locale="en-US" />);
		expect(container.textContent).toBe("");
		rerender(<LocalDateTime value={undefined} locale="en-US" />);
		expect(container.textContent).toBe("");
	});

	it("renders the fallback for nullish values", () => {
		render(<LocalDateTime value={null} locale="en-US" fallback="—" />);
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("renders the fallback for invalid dates", () => {
		const { container } = render(<LocalDateTime value="not a date" locale="en-US" />);
		expect(container.textContent).toBe("");
		cleanup();
		render(<LocalDateTime value={new Date(NaN)} locale="en-US" fallback="bad" />);
		expect(screen.getByText("bad")).toBeTruthy();
	});
});
