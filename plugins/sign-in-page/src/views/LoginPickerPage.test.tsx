// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { definePlugin, type Plugin } from "@ktb/kernel";

import type { PageContext } from "@ktb/kernel";

// Link needs a router context; the picker only uses it as a plain anchor.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		Link: ({ to, children, className }: { to: string; children?: unknown; className?: string }) =>
			React.createElement("a", { href: to, className }, children as never),
	};
});

import { LoginPickerPage } from "./LoginPickerPage.tsx";

const Icon = () => null;
const tile = (id: string, to: string, pkg: string, requires?: readonly string[]) =>
	definePlugin({
		id,
		pkg,
		meta: { keywords: ["ui"] },
		chrome: [
			{
				id: `chrome.${id}`,
				region: "app.login.tiles",
				content: {
					kind: "loginTile",
					to,
					labelKey: `nav_${id}_login`,
					fallback: `${id} sign in`,
					icon: Icon,
					...(requires === undefined ? {} : { requires }),
				},
			},
		],
	});

/** Minimal registry exercising the picker's tile gate: patient tile
 * ungated, doctor tile requires the clinical packages. */
const plugins: Plugin[] = [
	tile("patient", "/login/patient", "patient-portal"),
	tile("doctor", "/login/doctor", "auth", ["doctors.services", "clinician.portal"]),
	definePlugin({ id: "doctors.services", pkg: "doctors", meta: { keywords: ["marker"] } }),
	definePlugin({ id: "clinician.portal", pkg: "clinician", meta: { keywords: ["marker"] } }),
];

const ctxWith = (
	enabled: readonly string[],
	catalog: Record<string, string> = {},
): PageContext => ({
	plugins,
	locale: "en",
	i18n: { locale: "en", catalog },
	pluginStates: { enabled },
});

const allEnabled = plugins.map((p) => p.id);
const withoutPkg = (pkg: string) =>
	allEnabled.filter((id) => {
		const plugin = plugins.find((p) => p.id === id);
		return plugin?.pkg !== pkg;
	});

describe("LoginPickerPage", () => {
	afterEach(cleanup);

	it("renders the heading and every live tile", () => {
		render(createElement(LoginPickerPage, { data: null, ctx: ctxWith(allEnabled) }));
		expect(screen.getByText("Sign in")).toBeTruthy();
		expect(screen.getByText("Choose your role to continue.")).toBeTruthy();
		expect(screen.getByRole("link", { name: "patient sign in" }).getAttribute("href")).toBe(
			"/login/patient",
		);
		expect(screen.getByRole("link", { name: "doctor sign in" }).getAttribute("href")).toBe(
			"/login/doctor",
		);
	});

	it("resolves tile labels from the app.* catalog slice before the fallback", () => {
		render(
			createElement(LoginPickerPage, {
				data: null,
				ctx: ctxWith(allEnabled, { "app.nav_patient_login": "I am a patient" }),
			}),
		);
		expect(screen.getByRole("link", { name: "I am a patient" })).toBeTruthy();
		// Missing keys keep the tile's declared English fallback.
		expect(screen.getByRole("link", { name: "doctor sign in" })).toBeTruthy();
	});

	it("hides tiles whose package is disabled", () => {
		render(createElement(LoginPickerPage, { data: null, ctx: ctxWith(withoutPkg("clinician")) }));
		expect(screen.getByRole("link", { name: "patient sign in" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "doctor sign in" })).toBeNull();
	});

	it("hides tiles whose owning plugin is disabled", () => {
		const enabled = allEnabled.filter((id) => !id.startsWith("patient"));
		render(createElement(LoginPickerPage, { data: null, ctx: ctxWith(enabled) }));
		expect(screen.queryByRole("link", { name: "patient sign in" })).toBeNull();
		expect(screen.getByRole("link", { name: "doctor sign in" })).toBeTruthy();
	});
});
