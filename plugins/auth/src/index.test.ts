import { describe, expect, it } from "vitest";

import { plugins, authRoutesPlugin, authChromePlugin } from "./index.ts";

describe("auth plugin manifests", () => {
	it("auth.routes is a system plugin mounting the credential pages + the /api subtree", () => {
		expect(authRoutesPlugin.id).toBe("auth.routes");
		expect(authRoutesPlugin.system).toBe(true);
		expect(authRoutesPlugin.routes).toHaveLength(4);
	});

	it("auth.chrome is a system plugin contributing the session menu and the doctor login tile", () => {
		expect(authChromePlugin.id).toBe("auth.chrome");
		expect(authChromePlugin.system).toBe(true);
		expect(authChromePlugin.chrome).toHaveLength(2);
		expect(authChromePlugin.chrome[0]).toMatchObject({
			region: "app.header.session",
			content: { kind: "component" },
		});
		expect(authChromePlugin.chrome[1]).toMatchObject({
			id: "auth.login.doctor",
			region: "app.login.tiles",
			order: 1,
			content: {
				kind: "loginTile",
				to: "/login/doctor",
				labelKey: "nav_doctor_login",
				requires: ["doctors.services", "clinician.portal"],
			},
		});
	});

	it("exports the discovery plugins array in order", () => {
		expect(plugins.map((p) => p.id)).toEqual(["auth.routes", "auth.chrome"]);
	});
});
