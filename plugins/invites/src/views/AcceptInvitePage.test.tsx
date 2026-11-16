// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type AuthResult = {
	data: { user: object } | null;
	error: { message: string } | null;
};
const okResult: AuthResult = { data: { user: {} }, error: null };
const signInEmail = vi.fn(async (_arg?: unknown): Promise<AuthResult> => okResult);

vi.mock("@ktb/auth-better/client", () => ({
	authClient: {
		signIn: { email: (arg: unknown) => signInEmail(arg) },
	},
}));
// The widget needs a site key and Cloudflare's script; the stand-in
// hands the page a token on demand.
vi.mock("@ktbhealth/ui/components/turnstile", async () => {
	const React = await import("react");
	return {
		Turnstile: ({ onToken }: { onToken: (token: string | null) => void }) =>
			React.createElement(
				"button",
				{ type: "button", onClick: () => onToken("captcha-token") },
				"Solve captcha",
			),
	};
});

import {
	AcceptInvitePage,
	type AcceptInviteApi,
	type AcceptInviteInvite,
} from "./AcceptInvitePage.tsx";

type Accepted = Awaited<ReturnType<AcceptInviteApi["accept"]>>;
const accept = vi.fn<AcceptInviteApi["accept"]>(async () => ({ ok: true }));
const assign = vi.fn<(url: string) => void>();

const secretary: AcceptInviteInvite = {
	email: "sec@ktb.test",
	kind: "secretary",
	inviterName: "Dra. Ana",
	accountExists: false,
};
const patient: AcceptInviteInvite = {
	email: "maria@ktb.test",
	kind: "patient",
	inviterName: "Dr. Caio",
	accountExists: false,
};

const page = (invite: AcceptInviteInvite | null, locale = "en") =>
	createElement(AcceptInvitePage, { invite, locale, api: { accept } }) as ReactElement;

const SUBMIT = "Create account and continue";

function fill(password = "senha12345", confirm = password) {
	fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Maria Souza" } });
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
	fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
}

async function submit() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
	});
}

const signInLink = () => screen.getByRole("link", { name: "Sign in" }).getAttribute("href");

describe("accept invite page", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		accept.mockResolvedValue({ ok: true });
		signInEmail.mockResolvedValue(okResult);
		vi.stubGlobal("location", { assign });
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	describe("with nothing to create", () => {
		it("tells a dead link is no longer valid and points to sign-in", () => {
			const { container } = render(page(null));
			expect(screen.getByText("This invitation is no longer valid")).toBeTruthy();
			expect(screen.getByText(/The link was already used or has expired\./)).toBeTruthy();
			expect(signInLink()).toBe("/login/doctor");
			expect(container.querySelector("form")).toBeNull();
			expect(container.querySelector("input")).toBeNull();
			expect(screen.queryByRole("button")).toBeNull();
		});

		it.each([
			[secretary, "/login/secretary"],
			[patient, "/login/patient"],
		] as const)(
			"sends an address that already has an account to the $kind sign-in",
			(invite, login) => {
				const { container } = render(page({ ...invite, accountExists: true }));
				expect(screen.getByText("You already have an account")).toBeTruthy();
				expect(
					screen.getByText(
						`${invite.email} already has a KTB Health account. Sign in with it to see what you were invited to.`,
					),
				).toBeTruthy();
				expect(signInLink()).toBe(login);
				expect(container.querySelector("form")).toBeNull();
				expect(container.querySelector("input")).toBeNull();
				expect(screen.queryByRole("button")).toBeNull();
			},
		);
	});

	describe("with a live link", () => {
		it.each([
			[secretary, "Dra. Ana invited you to work on their behalf"],
			[patient, "Dr. Caio gave you access to the patient portal"],
		] as const)("names the inviter of a $kind invite", (invite, heading) => {
			render(page(invite));
			expect(screen.getByText(heading)).toBeTruthy();
			expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
		});

		it("shows the invited address, which cannot be changed", () => {
			render(page(secretary));
			const email = screen.getByLabelText("Email") as HTMLInputElement;
			expect(email.value).toBe("sec@ktb.test");
			expect(email.readOnly).toBe(true);
			expect((screen.getByLabelText("Full name") as HTMLInputElement).readOnly).toBe(false);
			expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
			expect((screen.getByLabelText("Confirm password") as HTMLInputElement).type).toBe("password");
		});

		it("blocks the submit when the passwords do not match", async () => {
			render(page(secretary));
			fill("senha12345", "different1");
			await submit();
			expect(screen.getByText("Passwords do not match.")).toBeTruthy();
			expect(accept).not.toHaveBeenCalled();
			expect(signInEmail).not.toHaveBeenCalled();
			expect(assign).not.toHaveBeenCalled();
			// Not stuck: fixing the confirmation goes through and clears the error.
			fireEvent.change(screen.getByLabelText("Confirm password"), {
				target: { value: "senha12345" },
			});
			await submit();
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			expect(accept).toHaveBeenCalledTimes(1);
			expect(screen.queryByText("Passwords do not match.")).toBeNull();
		});

		it.each([
			[secretary, "/"],
			[patient, "/portal/patient"],
		] as const)("creates the account, signs in and opens the $kind home", async (invite, home) => {
			render(page(invite));
			fill();
			fireEvent.click(screen.getByRole("button", { name: "Solve captcha" }));
			await submit();
			await waitFor(() => expect(assign).toHaveBeenCalled());
			expect(accept.mock.calls).toEqual([[{ name: "Maria Souza", password: "senha12345" }]]);
			expect(signInEmail.mock.calls).toEqual([
				[{ email: invite.email, password: "senha12345", captchaToken: "captcha-token" }],
			]);
			// The account exists before anyone signs in to it.
			expect(accept.mock.invocationCallOrder[0]!).toBeLessThan(
				signInEmail.mock.invocationCallOrder[0]!,
			);
			expect(signInEmail.mock.invocationCallOrder[0]!).toBeLessThan(
				assign.mock.invocationCallOrder[0]!,
			);
			expect(assign.mock.calls).toEqual([[home]]);
			// Still pending while the browser navigates away.
			const button = screen.getByRole("button", { name: /Please wait…/ });
			expect(button).toHaveProperty("disabled", true);
			expect(screen.queryByText("Account created")).toBeNull();
		});

		it("signs in without a captcha token when the challenge was not solved", async () => {
			render(page(secretary));
			fill();
			await submit();
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			expect(signInEmail.mock.calls).toEqual([
				[{ email: "sec@ktb.test", password: "senha12345", captchaToken: undefined }],
			]);
		});

		it.each([
			["invalid", "This invitation is no longer valid. Ask for a new one."],
			["account_exists", "This email address already has an account. Sign in instead."],
			["invalid_name", "Enter your name."],
			["invalid_password", "Choose a password with 8 to 128 characters."],
		] as const)("explains a %s rejection and does not sign in", async (error, message) => {
			accept.mockResolvedValue({ ok: false, error });
			render(page(secretary));
			fill();
			await submit();
			expect(await screen.findByText(message)).toBeTruthy();
			expect(accept).toHaveBeenCalledTimes(1);
			expect(signInEmail).not.toHaveBeenCalled();
			expect(assign).not.toHaveBeenCalled();
			// The form is back for another try.
			expect(screen.getByRole("button", { name: SUBMIT })).toHaveProperty("disabled", false);
			expect(screen.queryByText("Account created")).toBeNull();
		});

		it("explains a request that did not complete and does not sign in", async () => {
			accept.mockRejectedValue(new Error("network down"));
			render(page(patient));
			fill();
			await submit();
			expect(
				await screen.findByText("Could not accept the invitation. Please try again."),
			).toBeTruthy();
			expect(signInEmail).not.toHaveBeenCalled();
			expect(assign).not.toHaveBeenCalled();
			expect(screen.getByRole("button", { name: SUBMIT })).toHaveProperty("disabled", false);
			// A retry that goes through replaces the error with the way in.
			accept.mockResolvedValue({ ok: true });
			await submit();
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal/patient"));
			expect(accept).toHaveBeenCalledTimes(2);
			expect(screen.queryByText("Could not accept the invitation. Please try again.")).toBeNull();
		});

		describe("when the account is created but signing in fails", () => {
			const failures = {
				"an error result": () =>
					signInEmail.mockResolvedValue({ data: null, error: { message: "captcha failed" } }),
				"a rejected request": () => signInEmail.mockRejectedValue(new Error("network down")),
			};

			it.each([
				["an error result", secretary, "/login/secretary"],
				["a rejected request", secretary, "/login/secretary"],
				["an error result", patient, "/login/patient"],
				["a rejected request", patient, "/login/patient"],
			] as const)(
				"on %s points a $kind invitee to their sign-in",
				async (failure, invite, login) => {
					failures[failure]();
					const { container } = render(page(invite));
					fill();
					await submit();
					expect(await screen.findByText("Account created")).toBeTruthy();
					expect(screen.getByText("Your account was created. Sign in to continue.")).toBeTruthy();
					expect(signInLink()).toBe(login);
					expect(accept).toHaveBeenCalledTimes(1);
					expect(signInEmail).toHaveBeenCalledTimes(1);
					expect(assign).not.toHaveBeenCalled();
					// Nothing left to submit: the account must not be created twice.
					expect(container.querySelector("form")).toBeNull();
					expect(screen.queryByRole("button")).toBeNull();
				},
			);
		});

		it("ignores a second submit while the first is pending", async () => {
			let resolveAccept: ((v: Accepted) => void) | null = null;
			accept.mockImplementation(
				() =>
					new Promise<Accepted>((r) => {
						resolveAccept = r;
					}),
			);
			const { container } = render(page(secretary));
			const form = container.querySelector("form")!;
			fill();
			fireEvent.submit(form);
			const button = await screen.findByRole("button", { name: /Please wait…/ });
			expect(button).toHaveProperty("disabled", true);
			expect(accept).toHaveBeenCalledTimes(1);
			await act(async () => {
				fireEvent.submit(form);
			});
			expect(accept).toHaveBeenCalledTimes(1);
			expect(signInEmail).not.toHaveBeenCalled();
			await act(async () => {
				resolveAccept?.({ ok: true });
			});
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			expect(accept).toHaveBeenCalledTimes(1);
			expect(signInEmail).toHaveBeenCalledTimes(1);
		});
	});

	describe("in pt-BR", () => {
		it("renders the form", async () => {
			render(page(secretary, "pt-BR"));
			expect(
				screen.getByText("Dra. Ana convidou você para trabalhar em nome dele(a)"),
			).toBeTruthy();
			expect((screen.getByLabelText("E-mail") as HTMLInputElement).value).toBe("sec@ktb.test");
			fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: "Maria" } });
			fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "senha12345" } });
			fireEvent.change(screen.getByLabelText("Confirmar senha"), {
				target: { value: "outra12345" },
			});
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Criar conta e continuar" }));
			});
			expect(screen.getByText("As senhas não coincidem.")).toBeTruthy();
			expect(accept).not.toHaveBeenCalled();
		});

		it("renders the notices", () => {
			render(page(null, "pt-BR"));
			expect(screen.getByText("Este convite não é mais válido")).toBeTruthy();
			expect(screen.getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe(
				"/login/doctor",
			);
			cleanup();
			render(page({ ...patient, accountExists: true }, "pt-BR"));
			expect(screen.getByText("Você já tem uma conta")).toBeTruthy();
			expect(screen.getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe(
				"/login/patient",
			);
		});
	});
});
