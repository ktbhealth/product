import { describe, expect, it } from "vitest";

import { asImageElementValue, IMAGE_FITS, isImageFit } from "./value.ts";

describe("asImageElementValue", () => {
	it("normalizes { imageId } objects and bare ids", () => {
		expect(asImageElementValue({ imageId: 3 })).toEqual({ imageId: 3 });
		expect(asImageElementValue(7)).toEqual({ imageId: 7 });
	});

	it("keeps alt overrides and valid fits", () => {
		expect(asImageElementValue({ imageId: 1, alt: "A cat", fit: "contain" })).toEqual({
			imageId: 1,
			alt: "A cat",
			fit: "contain",
		});
	});

	it("drops blank alt, invalid fits and non-positive ids", () => {
		expect(asImageElementValue({ imageId: 1, alt: "  ", fit: "bogus" })).toEqual({
			imageId: 1,
		});
		expect(asImageElementValue({ imageId: 0 })).toBeNull();
		expect(asImageElementValue({ imageId: -2 })).toBeNull();
		expect(asImageElementValue({ imageId: 1.5 })).toBeNull();
		expect(asImageElementValue(0)).toBeNull();
		expect(asImageElementValue(-1)).toBeNull();
		expect(asImageElementValue(2.5)).toBeNull();
	});

	it("rejects non-object, null and malformed values", () => {
		for (const value of [null, undefined, "x", {}, { imageId: "1" }, [], true]) {
			expect(asImageElementValue(value)).toBeNull();
		}
	});
});

describe("IMAGE_FITS / isImageFit", () => {
	it("covers the three object-fit modes", () => {
		expect(IMAGE_FITS).toEqual(["cover", "contain", "fill"]);
		expect(isImageFit("cover")).toBe(true);
		expect(isImageFit("none")).toBe(false);
		expect(isImageFit(1)).toBe(false);
	});
});
