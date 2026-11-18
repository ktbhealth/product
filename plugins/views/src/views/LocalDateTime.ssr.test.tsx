// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalDateTime } from "./LocalDateTime.tsx";

// No `@vitest-environment jsdom` pragma: this file runs in node where
// `window` is undefined, so `useSyncExternalStore` takes the server
// snapshot — the SSR path that must never emit locale-formatted text.
describe("LocalDateTime (SSR)", () => {
	it("renders the fallback instead of locale text", () => {
		const html = renderToString(
			<LocalDateTime value={new Date("2026-03-04T15:30:00Z")} locale="en-US" fallback="—" />,
		);
		expect(html).toBe("—");
	});

	it("renders nothing by default", () => {
		const html = renderToString(<LocalDateTime value={Date.now()} locale="en-US" />);
		expect(html).toBe("");
	});
});
