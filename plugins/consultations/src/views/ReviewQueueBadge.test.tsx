// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PendingReviewCountContext } from "../context.ts";
import { ReviewQueueBadge } from "./ReviewQueueBadge.tsx";

const renderBadge = (count: number, locale = "en") =>
	render(
		<PendingReviewCountContext.Provider value={count}>
			<ReviewQueueBadge locale={locale} />
		</PendingReviewCountContext.Provider>,
	);

afterEach(cleanup);

describe("ReviewQueueBadge", () => {
	it("renders nothing at zero pending reviews", () => {
		const { container } = renderBadge(0);
		expect(container.firstChild).toBeNull();
	});

	it("renders the pending count pill", () => {
		renderBadge(3);
		const badge = screen.getByLabelText("3 pending review");
		expect(badge.textContent).toBe("3");
	});

	it("localizes the accessible label", () => {
		renderBadge(2, "pt-BR");
		expect(screen.getByLabelText("2 pendentes de revisão")).toBeTruthy();
	});
});
