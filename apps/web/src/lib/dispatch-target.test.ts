import { describe, expect, it } from "vitest";

import { dispatchTarget } from "./dispatch-target.ts";

// Real client registry: the contributed portal instances are
// "platform" (@ktb/platform), "doctor"/"secretary" (clinician) and
// "patient" (patient-portal).
describe("dispatchTarget", () => {
	it("classifies the bare root as landing", () => {
		expect(dispatchTarget("/")).toEqual({ kind: "landing", path: "/" });
	});

	it("classifies /platform and nested paths as the platform console", () => {
		expect(dispatchTarget("/platform")).toEqual({
			kind: "platform",
			path: "/platform",
			instanceId: "platform",
		});
		expect(dispatchTarget("/platform/patients")).toEqual({
			kind: "platform",
			path: "/platform/patients",
			instanceId: "platform",
		});
	});

	it("classifies contributed portal instances as portal", () => {
		for (const [path, instanceId] of [
			["/portal/doctor", "doctor"],
			["/portal/doctor/appointments", "doctor"],
			["/portal/secretary", "secretary"],
			["/portal/patient/billing", "patient"],
		] as const) {
			expect(dispatchTarget(path)).toEqual({ kind: "portal", path, instanceId });
		}
	});

	it("falls through to app pages for unknown portal instance ids", () => {
		// "/portal/login" is the sign-in-page legacy redirect descriptor —
		// "login" is not a contributed instance, so app pages own it.
		expect(dispatchTarget("/portal/login")).toEqual({ kind: "app", path: "/portal/login" });
		expect(dispatchTarget("/portal/ghost/x")).toEqual({ kind: "app", path: "/portal/ghost/x" });
	});

	it("classifies bare /portal and lookalike prefixes as app", () => {
		expect(dispatchTarget("/portal")).toEqual({ kind: "app", path: "/portal" });
		expect(dispatchTarget("/portal/")).toEqual({ kind: "app", path: "/portal/" });
		// "/platformx" is not under the /platform instance root.
		expect(dispatchTarget("/platformx")).toEqual({ kind: "app", path: "/platformx" });
		expect(dispatchTarget("/about")).toEqual({ kind: "app", path: "/about" });
	});
});
