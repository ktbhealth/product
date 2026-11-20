// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
	(globalThis as Record<string, unknown>).ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia;
});

describe("puck editor smoke", () => {
	it("mounts", async () => {
		const { Puck } = await import("@puckeditor/core");
		const config = { components: { Heading: { render: () => null } } };
		const { container } = render(<Puck config={config as never} data={{ content: [] } as never} />);
		expect(container.innerHTML.length).toBeGreaterThan(0);
	});
});
