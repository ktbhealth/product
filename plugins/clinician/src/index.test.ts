import { describe, expect, it } from "vitest";

import {
	clinicianChromePlugin,
	clinicianPagesPlugin,
	clinicianPortalPlugin,
	plugins,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";

const doctorPaths = (instance: string) => [
	`/portal/${instance}`,
	`/portal/${instance}/patients`,
	`/portal/${instance}/consultations`,
	`/portal/${instance}/patients/*`,
	`/portal/${instance}/consultations/*`,
	`/portal/${instance}/review`,
	`/portal/${instance}/review/*`,
	`/portal/${instance}/activity`,
];

describe("clinician portal plugins", () => {
	it("declares the doctor and secretary instances — role audiences, doctor subject", () => {
		expect(clinicianPortalPlugin.id).toBe("clinician.portal");
		expect(clinicianPortalPlugin.portals).toEqual([
			{
				id: "doctor",
				basePath: "/portal/doctor",
				label: "Doctor",
				audience: "doctor",
				subject: "doctor",
			},
			{
				id: "secretary",
				basePath: "/portal/secretary",
				label: "Secretary",
				audience: "secretary",
				subject: "doctor",
			},
		]);
	});

	it("declares the shared page set — home, patients, consultations and activity — under both instance bases", () => {
		expect(clinicianPagesPlugin.id).toBe("clinician.pages");
		expect(clinicianPagesPlugin.optionalDeps).toEqual(["audit.services"]);
		const pages = clinicianPagesPlugin.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual([
			...doctorPaths("doctor"),
			...doctorPaths("secretary"),
		]);
		// List pages carry owner-scoped loaders; the home pages do not.
		expect("loader" in pages[0]!).toBe(false);
		expect("loader" in pages[1]!).toBe(true);
		expect("loader" in pages[2]!).toBe(true);
		// Wildcard record pages guard + load by request path.
		expect("guard" in pages[3]!).toBe(true);
		expect("guard" in pages[4]!).toBe(true);
		// Review mode (PL-023): the queue overview loads without a guard;
		// the wildcard item page guards like the record page.
		expect("loader" in pages[5]!).toBe(true);
		expect("loader" in pages[6]!).toBe(true);
		expect("guard" in pages[6]!).toBe(true);
		// The activity feed guards on the audit.read grant and loads the
		// tenant-scoped feed.
		expect("guard" in pages[7]!).toBe(true);
		expect("loader" in pages[7]!).toBe(true);
	});

	it("scopes every sidebar item to its own instance", () => {
		expect(clinicianChromePlugin.id).toBe("clinician.chrome");
		const entries = clinicianChromePlugin.chrome ?? [];
		expect(entries).toHaveLength(10);
		expect(entries.map((e) => e.portal)).toEqual([
			"doctor",
			"doctor",
			"doctor",
			"doctor",
			"doctor",
			"secretary",
			"secretary",
			"secretary",
			"secretary",
			"secretary",
		]);
		for (const entry of entries) {
			expect(entry.region).toBe("portal.sidebar");
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
		expect(clientPlugins[1]!.optionalDeps).toEqual(clinicianPagesPlugin.optionalDeps);
		// Client page descriptors never carry server handlers.
		for (const page of clientPages) {
			expect("loader" in page).toBe(false);
			expect("guard" in page).toBe(false);
		}
	});
});
