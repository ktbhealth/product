// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("#/lib/i18n.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/i18n.ts")>();
	return {
		...actual,
		useRootI18nSlice: () => undefined,
	};
});
// Link needs a router context; the page only uses it as a plain anchor.
// The route keeps its options.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
			React.createElement("a", { href: to, ...props }, children),
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
	};
});

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
});
