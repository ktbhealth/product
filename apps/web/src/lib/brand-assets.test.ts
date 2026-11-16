import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KTB_DEFAULT_THEME } from "@ktb/theme/default-theme";

// T-122: the default theme serves brand assets from static copies in
// apps/web/public/brand/ (jiti cannot resolve `?url` asset imports during
// route typegen). The canonical sources live in @ktbhealth/ui
// (packages/brand/assets, exported as `@ktbhealth/ui/brand/*`); this test
// pins every referenced file byte-for-byte so an upstream ui release
// that changes the brand kit fails here until public/brand is re-synced.

const require = createRequire(import.meta.url);
const publicBrandDir = fileURLToPath(new URL("../../public/brand/", import.meta.url));

const brandRefs = [
	KTB_DEFAULT_THEME.brand?.logoLight,
	KTB_DEFAULT_THEME.brand?.logoDark,
	KTB_DEFAULT_THEME.brand?.wordmark,
	KTB_DEFAULT_THEME.brand?.favicon,
].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);

describe("brand assets — public/brand mirrors @ktbhealth/ui/brand", () => {
	it("the default theme references at least one /brand/* asset", () => {
		expect(brandRefs.length).toBeGreaterThan(0);
		for (const ref of brandRefs) {
			expect(ref.startsWith("/brand/")).toBe(true);
		}
	});

	it.each([...new Set(brandRefs)])("%s is a byte-identical copy of the ui brand asset", (ref) => {
		const name = basename(ref);
		// Resolving through the package exports map proves the file ships
		// in the pinned ui release; a missing export throws here.
		const uiAssetPath = require.resolve(`@ktbhealth/ui/brand/${name}`);
		const publicPath = join(publicBrandDir, name);
		const publicBytes = readFileSync(publicPath);
		const uiBytes = readFileSync(uiAssetPath);
		expect(publicBytes.length).toBeGreaterThan(0);
		expect(publicBytes.equals(uiBytes)).toBe(true);
		// Sanity: the resolved file really is the brand package asset.
		expect(dirname(uiAssetPath)).toContain(join("packages", "brand", "assets"));
	});
});
