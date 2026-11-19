// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { definePlugin, type Plugin } from "@ktb/kernel";

import type { PageContext } from "@ktb/kernel";

type AuthResult = {
	data: { user: object } | null;
	error: { message?: string } | null;
};
const okResult: AuthResult = { data: { user: {} }, error: null };

const mocks = vi.hoisted(() => ({
	portalAudiencesFn: vi.fn(async (): Promise<readonly string[]> => ["member", "patient"]),
	doctorContextFn: vi.fn(
		async (): Promise<{
			profiles: { doctorId: number; displayName: string; role: string }[];
			activeDoctorId: number | null;
		} | null> => null,
	),
}));
const signInEmail = vi.fn(async (_arg?: unknown): Promise<AuthResult> => okResult);
const signUpEmail = vi.fn(async (_arg?: unknown): Promise<AuthResult> => okResult);

vi.mock("@ktb/auth-better/client", () => ({
	authClient: {
		signIn: { email: (arg: unknown) => signInEmail(arg) },
		signUp: { email: (arg: unknown) => signUpEmail(arg) },
	},
}));
vi.mock("../fns.ts", () => ({ portalAudiencesFn: mocks.portalAudiencesFn }));
vi.mock("@ktb/doctors/fns", () => ({ doctorContextFn: mocks.doctorContextFn }));
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
// Link needs a router context; the page only uses it as a plain anchor.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		Link: ({ to, children, className }: { to: string; children?: unknown; className?: string }) =>
			React.createElement("a", { href: to, className }, children as never),
	};
});
// ForgotPasswordLink renders a Link — the same mock covers it.

import { PortalSignInPage } from "./PortalSignInPage.tsx";

const Icon = () => null;
/** Doctor sign-in tile owned by the auth package, gated on the
 * clinical packages — same shape as the real auth.chrome entry. */
const doctorTilePlugin: Plugin = definePlugin({
	id: "auth.chrome",
	pkg: "auth",
	meta: { keywords: ["ui"] },
	chrome: [
		{
			id: "auth.login.doctor",
			region: "app.login.tiles",
			content: {
				kind: "loginTile",
				to: "/login/doctor",
				labelKey: "nav_doctor_login",
				fallback: "Doctor sign in",
				icon: Icon,
				requires: ["doctors.services", "clinician.portal"],
			},
		},
	],
});
const supportPlugins: Plugin[] = [
	doctorTilePlugin,
	definePlugin({ id: "doctors.services", pkg: "doctors", meta: { keywords: ["marker"] } }),
	definePlugin({ id: "clinician.portal", pkg: "clinician", meta: { keywords: ["marker"] } }),
];

const ctxWith = (enabled: readonly string[]): PageContext => ({
	plugins: supportPlugins,
	locale: "en",
	pluginStates: { enabled },
});

const allEnabled = supportPlugins.map((p) => p.id);
const withoutPkg = (pkg: string) =>
	allEnabled.filter((id) => supportPlugins.find((p) => p.id === id)?.pkg !== pkg);

const Page = ({
	data = { emailEnabled: false },
	enabled = allEnabled,
}: {
	data?: unknown;
	enabled?: readonly string[];
}) =>
	createElement(PortalSignInPage, {
		data,
		ctx: ctxWith(enabled),
	}) as ReactElement;

const assign = vi.fn<(url: string) => void>();

const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string | RegExp) =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name }));
	});
const openSignUp = () => fireEvent.click(screen.getByRole("tab", { name: "Create account" }));

async function signIn() {
	type("Email", "ana@x.com");
	type("Password", "senha12345");
	await press("Sign in");
}

async function signUp({ confirm = "senha12345", name = "Ana Souza" } = {}) {
	openSignUp();
	type("Full name", name);
	type("Email", "ana@x.com");
	type("Password", "senha12345");
	type("Confirm password", confirm);
	await press("Create account");
}

describe("PortalSignInPage (/login/patient)", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	beforeEach(() => {
		assign.mockClear();
		signInEmail.mockReset();
		signUpEmail.mockReset();
		signInEmail.mockResolvedValue(okResult);
		signUpEmail.mockResolvedValue(okResult);
		mocks.portalAudiencesFn.mockReset();
		mocks.portalAudiencesFn.mockResolvedValue(["member", "patient"]);
		mocks.doctorContextFn.mockReset();
		mocks.doctorContextFn.mockResolvedValue(null);
		vi.stubGlobal("location", { assign });
	});

	it("opens on sign-in asking only for credentials", () => {
		render(createElement(Page, {}));
		expect(screen.getByText("Patient portal")).toBeTruthy();
		expect(screen.getByText("Sign in to see your consultations.")).toBeTruthy();
		expect(screen.queryByLabelText("Full name")).toBeNull();
		expect(screen.queryByLabelText("Confirm password")).toBeNull();
		expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
		expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", false);
	});

	it("switches to the create-account form", () => {
		render(createElement(Page, {}));
		openSignUp();
		expect(screen.getByText("Create patient account")).toBeTruthy();
		expect(screen.getByLabelText("Full name")).toBeTruthy();
		expect(screen.getByLabelText("Confirm password")).toBeTruthy();
		expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
		expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
	});

	it("signs in with the credentials and lands on the portal", async () => {
		render(createElement(Page, {}));
		await signIn();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal"));
		expect(signInEmail).toHaveBeenCalledWith({
			email: "ana@x.com",
			password: "senha12345",
			captchaToken: undefined,
		});
		expect(signUpEmail).not.toHaveBeenCalled();
		// Stays pending until the browser navigates away.
		expect(screen.getByRole("button", { name: /Please wait…/ })).toHaveProperty("disabled", true);
	});

	it("routes a staff account (no patient audience) through the doctor funnel", async () => {
		mocks.portalAudiencesFn.mockResolvedValue(["member", "doctor", "clinician"]);
		mocks.doctorContextFn.mockResolvedValue({
			profiles: [{ doctorId: 7, displayName: "Dr. Ana", role: "owner" }],
			activeDoctorId: 7,
		});
		render(createElement(Page, {}));
		await signIn();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it("sends a multi-profile staff account to the doctor chooser", async () => {
		mocks.portalAudiencesFn.mockResolvedValue(["member", "doctor", "clinician"]);
		mocks.doctorContextFn.mockResolvedValue({
			profiles: [
				{ doctorId: 7, displayName: "Dr. Ana", role: "owner" },
				{ doctorId: 8, displayName: "Clinic", role: "secretary" },
			],
			activeDoctorId: null,
		});
		render(createElement(Page, {}));
		await signIn();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/doctors/select"));
	});

	it("falls back to the portal when the audience lookup fails", async () => {
		mocks.portalAudiencesFn.mockRejectedValue(new Error("boom"));
		render(createElement(Page, {}));
		await signIn();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal"));
	});

	it("sends a staff account with no resolvable doctor context to the app home", async () => {
		mocks.portalAudiencesFn.mockResolvedValue(["member", "doctor"]);
		render(createElement(Page, {}));
		await signIn();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
	});

	it("offers the doctor sign-in link while its flow is live", () => {
		render(createElement(Page, {}));
		expect(screen.getByRole("link", { name: "I am a doctor" }).getAttribute("href")).toBe(
			"/login/doctor",
		);
	});

	it.each(["doctors", "clinician"] as const)(
		"hides the doctor link when the %s package is disabled",
		(pkg) => {
			render(createElement(Page, { enabled: withoutPkg(pkg) }));
			expect(screen.queryByRole("link", { name: "I am a doctor" })).toBeNull();
		},
	);

	it("forwards the captcha token once the challenge is solved", async () => {
		render(createElement(Page, {}));
		fireEvent.click(screen.getByRole("button", { name: "Solve captcha" }));
		await signIn();
		await waitFor(() => expect(signInEmail).toHaveBeenCalled());
		expect(signInEmail.mock.calls[0]![0]).toMatchObject({ captchaToken: "captcha-token" });
	});

	it("creates a patient account under the trimmed name", async () => {
		render(createElement(Page, {}));
		await signUp({ name: "  Ana Souza " });
		await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1));
		expect(signUpEmail).toHaveBeenCalledWith({
			email: "ana@x.com",
			password: "senha12345",
			captchaToken: undefined,
			name: "Ana Souza",
			callbackURL: "/verify-email",
		});
		expect(signInEmail).not.toHaveBeenCalled();
	});

	it("sends a new account to the verification step when email is enabled", async () => {
		render(createElement(Page, { data: { emailEnabled: true } }));
		await signUp();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/verify-email"));
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it("sends a new account straight to the portal when email is disabled", async () => {
		render(createElement(Page, { data: { emailEnabled: false } }));
		await signUp();
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal"));
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it("blocks sign-up when the passwords do not match", async () => {
		render(createElement(Page, {}));
		await signUp({ confirm: "different1" });
		await screen.findByText("Passwords do not match.");
		expect(signUpEmail).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	it("shows the server error and lets the user try again", async () => {
		signInEmail.mockResolvedValueOnce({ data: null, error: { message: "Invalid credentials" } });
		render(createElement(Page, {}));
		await signIn();
		await screen.findByText("Invalid credentials");
		expect(assign).not.toHaveBeenCalled();
		await press("Sign in");
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal"));
		expect(screen.queryByText("Invalid credentials")).toBeNull();
	});
});
