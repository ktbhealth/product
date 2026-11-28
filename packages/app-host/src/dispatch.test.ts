import { describe, expect, it } from "vitest";

import { classifyDispatchTarget, type PageDataResult } from "./dispatch.ts";
import type { PortalInstanceEntry } from "./pages.ts";

const entry = (id: string): PortalInstanceEntry =>
	({
		instance: { id, basePath: `/portal/${id}`, label: id },
		pluginId: `${id}.plugin`,
	}) as PortalInstanceEntry;

const portals = [entry("platform"), entry("doctor"), entry("patient")];

describe("classifyDispatchTarget", () => {
	it("classifies the bare root as landing", () => {
		expect(classifyDispatchTarget("/", portals)).toEqual({ kind: "landing", path: "/" });
	});

	it("classifies /platform and nested paths as the platform console", () => {
		expect(classifyDispatchTarget("/platform", portals)).toEqual({
			kind: "platform",
			path: "/platform",
			instanceId: "platform",
		});
		expect(classifyDispatchTarget("/platform/patients", portals)).toEqual({
			kind: "platform",
			path: "/platform/patients",
			instanceId: "platform",
		});
	});

	it("classifies contributed portal instances as portal", () => {
		for (const [path, instanceId] of [
			["/portal/doctor", "doctor"],
			["/portal/doctor/appointments", "doctor"],
			["/portal/patient/billing", "patient"],
		] as const) {
			expect(classifyDispatchTarget(path, portals)).toEqual({
				kind: "portal",
				path,
				instanceId,
			});
		}
	});

	it("falls through to app pages for unknown portal instance ids", () => {
		expect(classifyDispatchTarget("/portal/login", portals)).toEqual({
			kind: "app",
			path: "/portal/login",
		});
		expect(classifyDispatchTarget("/portal/ghost/x", portals)).toEqual({
			kind: "app",
			path: "/portal/ghost/x",
		});
	});

	it("classifies bare /portal and lookalike prefixes as app", () => {
		expect(classifyDispatchTarget("/portal", portals)).toEqual({ kind: "app", path: "/portal" });
		expect(classifyDispatchTarget("/portal/", portals)).toEqual({ kind: "app", path: "/portal/" });
		expect(classifyDispatchTarget("/platformx", portals)).toEqual({
			kind: "app",
			path: "/platformx",
		});
		expect(classifyDispatchTarget("/about", portals)).toEqual({ kind: "app", path: "/about" });
	});
});

describe("PageDataResult", () => {
	it("is a type-only export (compile-time contract)", () => {
		const ok: PageDataResult = { status: "ok", data: null };
		const nf: PageDataResult = { status: "notfound" };
		const red: PageDataResult = { status: "redirect", to: "/x" };
		expect([ok.status, nf.status, red.status]).toEqual(["ok", "notfound", "redirect"]);
	});
});
