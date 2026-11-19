import { describe, expect, it } from "vitest";

import { LegacyPortalLoginPage, legacyPortalLoginBeforeLoad } from "./legacy-redirect.tsx";
import { plugins } from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("legacy /portal/login redirect descriptor", () => {
	it("sends visitors to the patient sign-in via the page beforeLoad hook", () => {
		// The hook returns a redirect outcome — appBeforeLoad translates
		// `redirectTo` into a router redirect (was a thrown redirect()
		// when this was a host file route).
		expect(legacyPortalLoginBeforeLoad()).toEqual({ redirectTo: "/login/patient" });
	});

	it("renders nothing — beforeLoad always redirects", () => {
		expect(LegacyPortalLoginPage()).toBeNull();
	});

	it("is contributed as an app page by both manifests", () => {
		for (const manifest of [plugins, clientPlugins]) {
			const page = manifest[0]?.pages?.find((p) => p.id === "sign-in-page.portal-login-legacy");
			expect(page?.path).toBe("/portal/login");
			expect(page?.context).toBe("app");
			expect(page?.component).toBe(LegacyPortalLoginPage);
			expect(page?.beforeLoad).toBe(legacyPortalLoginBeforeLoad);
		}
	});
});
