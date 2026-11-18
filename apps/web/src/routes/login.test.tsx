// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";

const missingKey = vi.hoisted(() => ({ current: null as string | null }));
const rootLoaderData = vi.hoisted(() => ({
	current: { pluginStates: { enabled: [] as string[] } },
}));

// Shared mock factories: Link → plain anchor, route keeps its options.
// `getRouteApi` returns controllable root loader data — the picker
// reads pluginStates from the root match.
vi.mock("#/lib/i18n.ts", (importOriginal) =>
	import("./-route-test-mocks.ts").then((m) => m.i18nMock(importOriginal, missingKey)),
);
vi.mock("@tanstack/react-router", (importOriginal) =>
	import("./-route-test-mocks.ts").then((m) =>
		m.routerMock(importOriginal, {
			getRouteApi: () => ({ useLoaderData: () => rootLoaderData.current }),
		}),
	),
);

import { Route } from "./login.tsx";
import { plugins } from "#/plugins.ts";

const options = (
	Route as unknown as {
		options: {
			component: () => ReactElement;
			head: (ctx?: unknown) => { meta: { title: string }[] };
		};
	}
).options;
const Page = options.component;

const allEnabled = () => ({ enabled: plugins.map((p) => p.id) });
const withoutPkg = (pkg: string) => ({
	enabled: plugins.filter((p) => p.pkg !== pkg).map((p) => p.id),
});

describe("/login role picker", () => {
	beforeEach(() => {
		rootLoaderData.current = { pluginStates: allEnabled() };
	});
	afterEach(() => {
		cleanup();
		missingKey.current = null;
	});

	it("sets the page title", () => {
		expect(options.head().meta[0]!.title).toBe("Sign in | KTB Health");
	});

	it("offers the patient, doctor and secretary sign-in entries", () => {
		rootLoaderData.current = { pluginStates: allEnabled() };
		render(createElement(Page));
		expect(screen.getByText("Sign in")).toBeTruthy();
		expect(screen.getByRole("link", { name: "I am a patient" }).getAttribute("href")).toBe(
			"/login/patient",
		);
		expect(screen.getByRole("link", { name: "I am a doctor" }).getAttribute("href")).toBe(
			"/login/doctor",
		);
		expect(screen.getByRole("link", { name: "I am a secretary" }).getAttribute("href")).toBe(
			"/login/secretary",
		);
	});

	it("hides the clinical roles when the clinician package is disabled", () => {
		rootLoaderData.current = { pluginStates: withoutPkg("clinician") };
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "I am a patient" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "I am a doctor" })).toBeNull();
		expect(screen.queryByRole("link", { name: "I am a secretary" })).toBeNull();
	});

	it("hides the secretary role when the secretaries package is disabled", () => {
		rootLoaderData.current = { pluginStates: withoutPkg("secretaries") };
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "I am a patient" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "I am a doctor" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "I am a secretary" })).toBeNull();
	});

	it("hides staff roles when the doctors package is disabled", () => {
		rootLoaderData.current = { pluginStates: withoutPkg("doctors") };
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "I am a patient" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "I am a doctor" })).toBeNull();
		expect(screen.queryByRole("link", { name: "I am a secretary" })).toBeNull();
	});

	it("hides the patient role when the patient-portal package is disabled", () => {
		rootLoaderData.current = { pluginStates: withoutPkg("patient-portal") };
		render(createElement(Page));
		expect(screen.queryByRole("link", { name: "I am a patient" })).toBeNull();
		expect(screen.getByRole("link", { name: "I am a doctor" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "I am a secretary" })).toBeTruthy();
	});

	it("falls back to the tile's declared English when a translation is missing", () => {
		missingKey.current = "app.nav_secretary_login";
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "Secretary sign in" })).toBeTruthy();
	});
});
