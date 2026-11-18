// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type AuthResult = {
	data: { user: object } | null;
	error: { message: string } | null;
};
const okResult: AuthResult = { data: { user: {} }, error: null };
const signInEmail = vi.fn<(arg?: unknown) => Promise<AuthResult>>(async () => okResult);
const platformAdminAccess = vi.fn<() => Promise<boolean>>(async () => true);

vi.mock("@ktb/auth-better/client", () => ({
	authClient: {
		useSession: () => ({ data: null, isPending: false }),
		signIn: { email: (arg: unknown) => signInEmail(arg) },
		signOut: vi.fn(),
	},
}));

vi.mock("../fns.ts", () => ({
	platformAdminAccessFn: () => platformAdminAccess(),
}));

// The view renders outside a router: Link degrades to a plain anchor.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		Link: ({ to, children, className }: { to: string; children?: unknown; className?: string }) =>
			React.createElement("a", { href: to, className }, children as never),
	};
});

import { AdminLoginPage } from "../views/AdminLoginPage.tsx";

const Page = () => createElement(AdminLoginPage, { locale: "en" }) as ReactElement;

async function fillAndSubmit() {
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "root@x.com" },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: "senha12345" },
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
	});
}

describe("admin sign-in page", () => {
	afterEach(cleanup);

	beforeEach(() => {
		signInEmail.mockClear();
		platformAdminAccess.mockClear();
		signInEmail.mockResolvedValue(okResult);
		platformAdminAccess.mockResolvedValue(true);
	});

	it("renders the admin heading and no sign-up tab", () => {
		render(createElement(Page));
		expect(screen.getByText("Administrator sign in")).toBeTruthy();
		expect(screen.queryByRole("tab")).toBeNull();
	});

	it("signs in, verifies admin access and lands on /platform", async () => {
		const assign = vi.fn<(url: string) => void>();
		vi.stubGlobal("location", { assign });
		render(createElement(Page));
		await fillAndSubmit();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/platform"));
		expect(signInEmail).toHaveBeenCalledTimes(1);
		expect(platformAdminAccess).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it("denies a signed-in non-admin account without navigating", async () => {
		platformAdminAccess.mockResolvedValue(false);
		const assign = vi.fn<(url: string) => void>();
		vi.stubGlobal("location", { assign });
		render(createElement(Page));
		await fillAndSubmit();
		await screen.findByText("This account does not have administrator access.");
		expect(assign).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("shows the auth error and skips the admin check on bad credentials", async () => {
		signInEmail.mockResolvedValue({
			data: null,
			error: { message: "invalid credentials" },
		});
		render(createElement(Page));
		await fillAndSubmit();
		await waitFor(() => expect(screen.getByText("invalid credentials")).toBeTruthy());
		expect(platformAdminAccess).not.toHaveBeenCalled();
	});

	it("links back to the regular sign-in", () => {
		render(createElement(Page));
		expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe(
			"/login/doctor",
		);
	});
});
