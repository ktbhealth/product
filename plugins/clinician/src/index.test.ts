import { describe, expect, it } from "vitest";

import {
	clinicianChromePlugin,
	clinicianPagesPlugin,
	clinicianPortalPlugin,
	plugins,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

describe("clinician portal plugins", () => {
	it("declares the clinician instance — clinician audience, doctor subject", () => {
		expect(clinicianPortalPlugin.id).toBe("clinician.portal");
		expect(clinicianPortalPlugin.portals).toEqual([
			{
				id: "clinician",
				basePath: "/portal/clinician",
				label: "Clinician",
				audience: "clinician",
				subject: "doctor",
			},
		]);
	});

	it("declares portal pages for home, patients and consultations", () => {
		expect(clinicianPagesPlugin.id).toBe("clinician.pages");
		const pages = clinicianPagesPlugin.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual([
			"/portal/clinician",
			"/portal/clinician/patients",
			"/portal/clinician/consultations",
			"/portal/clinician/patients/*",
			"/portal/clinician/consultations/*",
		]);
		// List pages carry owner-scoped loaders; the home page does not.
		expect("loader" in pages[0]!).toBe(false);
		expect("loader" in pages[1]!).toBe(true);
		expect("loader" in pages[2]!).toBe(true);
		// Wildcard record pages guard + load by request path.
		expect("guard" in pages[3]!).toBe(true);
		expect("guard" in pages[4]!).toBe(true);
	});

	it("scopes every sidebar item to the clinician instance", () => {
		expect(clinicianChromePlugin.id).toBe("clinician.chrome");
		const entries = clinicianChromePlugin.chrome ?? [];
		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(entry.region).toBe("portal.sidebar");
			expect(entry.portal).toBe("clinician");
		}
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"clinician.portal",
			"clinician.pages",
			"clinician.chrome",
		]);
	});

	it("client mirror keeps ids, deps, portals, pages and chrome", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual(plugins.map((p) => p.id));
		const clientPortal = clientPlugins[0]!;
		expect(clientPortal.portals).toEqual(clinicianPortalPlugin.portals);
		const clientPages = clientPlugins[1]!.pages ?? [];
		expect(clientPages.map((p) => [p.id, p.path])).toEqual(
			(clinicianPagesPlugin.pages ?? []).map((p) => [p.id, p.path]),
		);
		// Client page descriptors never carry server handlers.
		for (const page of clientPages) {
			expect("loader" in page).toBe(false);
			expect("guard" in page).toBe(false);
		}
	});
});
