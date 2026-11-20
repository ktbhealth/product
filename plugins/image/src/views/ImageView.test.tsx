// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ImageView, type ImageViewPayload } from "./ImageView.tsx";

const payload = (over: Partial<ImageViewPayload> = {}): ImageViewPayload => ({
	src: "/api/images/7",
	alt: "A cat",
	...over,
});

afterEach(cleanup);

describe("ImageView", () => {
	it("renders a responsive img from the resolved payload", () => {
		const { container } = render(
			<ImageView value={payload({ width: 640, height: 480, fit: "cover", title: "Cat" })} />,
		);
		const img = container.querySelector("img")!;
		expect(img.getAttribute("src")).toBe("/api/images/7");
		expect(img.getAttribute("alt")).toBe("A cat");
		expect(img.getAttribute("width")).toBe("640");
		expect(img.getAttribute("height")).toBe("480");
		expect(img.getAttribute("title")).toBe("Cat");
		expect(img.getAttribute("loading")).toBe("lazy");
		expect(img.className).toContain("w-full");
		expect(img.className).toContain("object-cover");
		expect(img.style.aspectRatio).toBe("640 / 480");
	});

	it("maps each fit mode to its object-fit utility", () => {
		for (const [fit, cls] of [
			["cover", "object-cover"],
			["contain", "object-contain"],
			["fill", "object-fill"],
		] as const) {
			const { container, unmount } = render(<ImageView value={payload({ fit })} />);
			expect(container.querySelector("img")!.className).toContain(cls);
			unmount();
		}
	});

	it("omits dimensions and aspect-ratio when unknown", () => {
		const { container } = render(<ImageView value={payload()} />);
		const img = container.querySelector("img")!;
		expect(img.getAttribute("width")).toBeNull();
		expect(img.getAttribute("height")).toBeNull();
		expect(img.style.aspectRatio).toBe("");
	});

	it("degrades malformed payloads to an empty placeholder", () => {
		for (const value of [null, undefined, "x", {}, { src: "" }, { src: 3 }]) {
			const { container, unmount } = render(<ImageView value={value as never} />);
			expect(container.querySelector("img")).toBeNull();
			unmount();
		}
	});
});
