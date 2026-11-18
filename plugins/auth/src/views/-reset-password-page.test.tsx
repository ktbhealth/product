// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type AuthResult = {
	data: { status: boolean } | null;
	error: { message?: string } | null;
};
const okResult: AuthResult = { data: { status: true }, error: null };
const resetPassword = vi.fn(async (_arg?: unknown): Promise<AuthResult> => okResult);

vi.mock("@ktb/auth-better/client", () => ({
	authClient: {
		resetPassword: (arg: unknown) => resetPassword(arg),
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

import { ResetPasswordPage } from "../views/ResetPasswordPage.tsx";

const Page = ({ token = "tok-1", invalid = false }: { token?: string; invalid?: boolean }) =>
	createElement(ResetPasswordPage, {
		locale: "en",
		token,
		invalid,
	}) as ReactElement;

const fill = (password: string, confirm: string) => {
	fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
	fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
};
const submit = () =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Update password" }));
	});

describe("reset-password page", () => {
	afterEach(cleanup);

	beforeEach(() => {
		resetPassword.mockClear();
		resetPassword.mockResolvedValue(okResult);
	});

	it("offers a fresh request when the link is invalid or carries no token", () => {
		render(createElement(Page, { invalid: true }));
		expect(screen.getByText("Invalid reset link")).toBeTruthy();
		expect(
			screen.getByText("This password reset link is invalid or has expired. Request a new one."),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe(
			"/forgot-password",
		);
		expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe(
			"/login",
		);
		expect(screen.queryByLabelText("New password")).toBeNull();
	});

	it("updates the password through the emailed token", async () => {
		render(createElement(Page));
		fill("nova-senha-9", "nova-senha-9");
		await submit();
		await waitFor(() => expect(resetPassword).toHaveBeenCalledTimes(1));
		expect(resetPassword).toHaveBeenCalledWith({
			newPassword: "nova-senha-9",
			token: "tok-1",
		});
		await screen.findByText("Password updated");
		expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe(
			"/login",
		);
	});

	it("blocks the submit when the passwords do not match", async () => {
		render(createElement(Page));
		fill("nova-senha-9", "outra-senha-9");
		await submit();
		await screen.findByText("Passwords do not match.");
		expect(resetPassword).not.toHaveBeenCalled();
	});

	it("shows the server error and lets the user retry", async () => {
		resetPassword.mockResolvedValueOnce({
			data: null,
			error: { message: "Invalid token" },
		});
		render(createElement(Page));
		fill("nova-senha-9", "nova-senha-9");
		await submit();
		await screen.findByText("Invalid token");
		await submit();
		await screen.findByText("Password updated");
	});

	it("falls back to the localized reset error when the failure carries no message", async () => {
		resetPassword.mockResolvedValueOnce({ data: null, error: {} });
		render(createElement(Page));
		fill("nova-senha-9", "nova-senha-9");
		await submit();
		await screen.findByText(
			"Could not update the password. The link may have expired — request a new one.",
		);
	});

	it("ignores the submit while one is in flight, with no password, or with no token", async () => {
		let release: (v: AuthResult) => void = () => {};
		resetPassword.mockImplementation(() => new Promise<AuthResult>((r) => (release = r)));
		// Defensive: the route never renders the form without a token,
		// but the guard also holds if the props say otherwise.
		const tokenless = render(
			createElement(ResetPasswordPage, {
				locale: "en",
				token: undefined,
				invalid: false,
			}),
		);
		let form = tokenless.container.querySelector("form")!;
		fireEvent.submit(form);
		expect(resetPassword).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("New password"), {
			target: { value: "nova-senha-9" },
		});
		fireEvent.submit(form);
		expect(resetPassword).not.toHaveBeenCalled();
		tokenless.unmount();

		const second = render(createElement(Page));
		form = second.container.querySelector("form")!;
		fill("nova-senha-9", "nova-senha-9");
		fireEvent.submit(form);
		await waitFor(() => expect(resetPassword).toHaveBeenCalledTimes(1));
		// Second submit while the first is still in flight is dropped.
		fireEvent.submit(form);
		expect(resetPassword).toHaveBeenCalledTimes(1);
		await act(async () => release(okResult));
	});
});
