// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";

const missingKey = vi.hoisted(() => ({ current: null as string | null }));

// Shared mock factories: Link → plain anchor, route keeps its options.
vi.mock("#/lib/i18n.ts", (importOriginal) =>
	import("./-route-test-mocks.ts").then((m) => m.i18nMock(importOriginal, missingKey)),
);
vi.mock("@tanstack/react-router", (importOriginal) =>
	import("./-route-test-mocks.ts").then((m) => m.routerMock(importOriginal)),
);

import { Route } from "./login.tsx";

const options = (
	Route as unknown as {
		options: {
			component: () => ReactElement;
			head: (ctx?: unknown) => { meta: { title: string }[] };
		};
	}
).options;
const Page = options.component;

describe("/login role picker", () => {
	afterEach(() => {
		cleanup();
		missingKey.current = null;
	});

	it("sets the page title", () => {
		expect(options.head().meta[0]!.title).toBe("Sign in | KTB Health");
	});

	it("offers the patient, doctor and secretary sign-in entries", () => {
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

	it("renders the raw key when a translation is missing", () => {
		missingKey.current = "app.nav_secretary_login";
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "nav_secretary_login" })).toBeTruthy();
	});
});
