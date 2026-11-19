// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchInput } from "./SearchInput.tsx";

afterEach(cleanup);

describe("SearchInput", () => {
	it("renders a search input with the standard width classes", () => {
		const { container } = render(
			<SearchInput value="" onChange={() => {}} placeholder="Search users" />,
		);
		const input = screen.getByPlaceholderText("Search users");
		expect(input.getAttribute("type")).toBe("search");
		expect(input.className).toContain("w-56");
		expect(input.className).toContain("sm:w-64");
		expect(container.querySelector("input")).toBe(input);
	});

	it("calls onChange with the string value", () => {
		const onChange = vi.fn<(value: string) => void>();
		render(<SearchInput value="" onChange={onChange} aria-label="Search" />);
		fireEvent.change(screen.getByLabelText("Search"), { target: { value: "ana" } });
		expect(onChange).toHaveBeenCalledWith("ana");
	});

	it("forwards extra input props and merges className", () => {
		const { container } = render(
			<SearchInput value="x" onChange={() => {}} className="extra-cls" disabled />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect(input.className).toContain("extra-cls");
		expect(input.className).toContain("w-56");
	});
});
