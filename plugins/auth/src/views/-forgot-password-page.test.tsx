// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type AuthResult = {
	data: { status: boolean } | null;
	error: { message?: string } | null;
};
const okResult: AuthResult = { data: { status: true }, error: null };
const requestPasswordReset = vi.fn(async (_arg?: unknown): Promise<AuthResult> => okResult);

vi.mock("@ktb/auth-better/client", () => ({
	authClient: {
		requestPasswordReset: (arg: unknown) => requestPasswordReset(arg),
	},
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

import { ForgotPasswordPage } from "../views/ForgotPasswordPage.tsx";

const loaderData = { emailEnabled: true };
const Page = () =>
	createElement(ForgotPasswordPage, {
		locale: "en",
		emailEnabled: loaderData.emailEnabled,
	}) as ReactElement;

const typeEmail = (value: string) =>
	fireEvent.change(screen.getByLabelText("Email"), { target: { value } });
const submit = () =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
	});

describe("forgot-password page", () => {
	afterEach(cleanup);

	beforeEach(() => {
		requestPasswordReset.mockClear();
		requestPasswordReset.mockResolvedValue(okResult);
		loaderData.emailEnabled = true;
	});

	it("shows the unavailable notice instead of a dead form when email is disabled", () => {
		loaderData.emailEnabled = false;
		render(createElement(Page));
		expect(screen.getByText("Password reset is not available on this deployment.")).toBeTruthy();
		expect(screen.queryByLabelText("Email")).toBeNull();
		expect(screen.queryByRole("button", { name: "Send reset link" })).toBeNull();
		// The way back stays.
		expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe(
			"/login",
		);
	});

	it("asks for the account email and confirms with the neutral message", async () => {
		render(createElement(Page));
		typeEmail("dra@x.com");
		await submit();
		await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledTimes(1));
		expect(requestPasswordReset).toHaveBeenCalledWith({
			email: "dra@x.com",
			redirectTo: "/reset-password",
			captchaToken: undefined,
		});
		await screen.findByText("If this address has an account, a reset link is on its way.");
	});

	it("trims the typed email before requesting", async () => {
		render(createElement(Page));
		typeEmail("  dra@x.com  ");
		await submit();
		await waitFor(() => expect(requestPasswordReset).toHaveBeenCalled());
		expect(requestPasswordReset).toHaveBeenCalledWith(
			expect.objectContaining({ email: "dra@x.com" }),
		);
	});

	it("shows the server error and clears the sent state on a retry", async () => {
		render(createElement(Page));
		typeEmail("dra@x.com");
		await submit();
		await screen.findByText(/reset link is on its way/);
		requestPasswordReset.mockResolvedValueOnce({
			data: null,
			error: { message: "rate limited" },
		});
		await submit();
		await screen.findByText("rate limited");
		expect(screen.queryByText(/reset link is on its way/)).toBeNull();
	});

	it("shows the fallback when the error has no message", async () => {
		requestPasswordReset.mockResolvedValueOnce({ data: null, error: {} });
		render(createElement(Page));
		typeEmail("dra@x.com");
		await submit();
		await screen.findByText("Could not sign in. Please try again.");
	});

	it("ignores submit while pending or when the email is blank", async () => {
		let release: (v: AuthResult) => void = () => {};
		requestPasswordReset.mockImplementation(() => new Promise<AuthResult>((r) => (release = r)));
		const { container } = render(createElement(Page));
		const form = container.querySelector("form")!;
		fireEvent.submit(form);
		expect(requestPasswordReset).not.toHaveBeenCalled();
		typeEmail("   ");
		fireEvent.submit(form);
		expect(requestPasswordReset).not.toHaveBeenCalled();
		typeEmail("dra@x.com");
		fireEvent.submit(form);
		await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledTimes(1));
		// Second submit while the first is still in flight is dropped.
		fireEvent.submit(form);
		expect(requestPasswordReset).toHaveBeenCalledTimes(1);
		await act(async () => release(okResult));
	});
});
