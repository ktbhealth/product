// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TablePagination, type TablePaginationProps } from "./Pagination.tsx";

afterEach(cleanup);

const renderPager = (props: Partial<TablePaginationProps> = {}) => {
	const onPrev = vi.fn<() => void>();
	const onNext = vi.fn<() => void>();
	render(
		<TablePagination
			page={1}
			pageCount={3}
			onPrev={onPrev}
			onNext={onNext}
			prevLabel="Previous"
			nextLabel="Next"
			{...props}
		/>,
	);
	return { onPrev, onNext };
};

describe("TablePagination", () => {
	it("renders labels and info, fires handlers on click", () => {
		const { onPrev, onNext } = renderPager({
			info: <span>Page 2 of 3</span>,
		});
		expect(screen.getByText("Page 2 of 3")).toBeTruthy();
		const prev = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
		const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
		expect(prev.disabled).toBe(false);
		expect(next.disabled).toBe(false);
		fireEvent.click(prev);
		fireEvent.click(next);
		expect(onPrev).toHaveBeenCalledTimes(1);
		expect(onNext).toHaveBeenCalledTimes(1);
	});

	it("disables prev on the first page and next on the last page", () => {
		renderPager({ page: 0, pageCount: 3 });
		expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		cleanup();
		renderPager({ page: 2, pageCount: 3 });
		expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("disables both buttons when disabled is set", () => {
		renderPager({ page: 1, pageCount: 3, disabled: true });
		expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("renders without info", () => {
		const { container } = render(
			<TablePagination
				page={0}
				pageCount={1}
				onPrev={() => {}}
				onNext={() => {}}
				prevLabel="Prev"
				nextLabel="Next"
			/>,
		);
		expect(container.querySelectorAll("button").length).toBe(2);
	});
});
