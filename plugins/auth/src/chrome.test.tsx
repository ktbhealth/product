// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, children, ...props }: Record<string, unknown>) =>
			React.createElement("a", { href: String(to), ...props }, children as ReactNode),
	};
});

import type { ChromeProps } from "@ktb/kernel";

import { SessionMenu } from "./chrome.tsx";

const props = (over: Partial<ChromeProps> = {}): ChromeProps => ({
	user: null,
	locale: "en",
	plugins: [],
	locales: ["en"],
	localeName: (l) => l,
	setLocale: vi.fn(),
	labels: {
		login: "Entrar",
		signOut: "Sair",
	},
	signOut: vi.fn(async () => {}),
	...over,
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("SessionMenu", () => {
	it("renders a single localized sign-in entry when anonymous", () => {
		render(<SessionMenu {...props()} />);
		expect(screen.getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/login");
		// The role choice moved to /login — no per-role entries here.
		expect(screen.queryByRole("link", { name: "Sou doutor" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Sou paciente" })).toBeNull();
	});

	it("falls back to the English label when the host fills none", () => {
		render(<SessionMenu {...props({ labels: {} })} />);
		expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
	});

	it("falls back to English labels and a placeholder avatar", async () => {
		const signOut = vi.fn(async () => {});
		render(
			<SessionMenu
				{...props({
					// No `name` → avatar fallback; no `signOut` label → English.
					user: { id: "u2", email: "noname@ktb.test" },
					labels: {},
					signOut,
				})}
			/>,
		);
		// The trigger renders the avatar fallback ("?") and an empty name.
		fireEvent.click(screen.getByRole("button"));
		const item = await screen.findByText("Sign out");
		fireEvent.click(item);
		await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
	});

	it("shows the account menu for a signed-in user and signs out", async () => {
		const signOut = vi.fn(async () => {});
		render(
			<SessionMenu
				{...props({
					user: { id: "u1", email: "bia@ktb.test", name: "Bia" },
					signOut,
				})}
			/>,
		);
		expect(screen.getByText("Bia")).toBeTruthy();
		fireEvent.click(screen.getByText("Bia"));
		const item = await screen.findByText("Sair");
		fireEvent.click(item);
		await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
	});

	it("offers a doctor account the portal links as full navigations", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		render(
			<SessionMenu
				{...props({
					user: {
						id: "u1",
						email: "bia@ktb.test",
						name: "Bia",
						patientOnly: false,
						clinicalRole: "owner",
						patientProfiles: 1,
					},
					labels: {
						doctorPortal: "Portal do médico",
						patientPortal: "Portal do paciente",
					},
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Bia"));
		// The profile actions moved into the clinical portal sidebars.
		expect(screen.queryByText("Switch doctor")).toBeNull();
		expect(screen.queryByText("Secretaries")).toBeNull();
		fireEvent.click(await screen.findByText("Portal do médico"));
		fireEvent.click(screen.getByText("Bia"));
		fireEvent.click(await screen.findByText("Portal do paciente"));
		expect(assign.mock.calls).toEqual([["/portal/doctor"], ["/portal/patient"]]);
	});

	it("shows the console entry only when the account passes the platform gate", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		const admin = {
			id: "v1",
			email: "val@ktb.test",
			name: "Val",
			patientOnly: false,
			platformAdmin: true,
		};
		render(<SessionMenu {...props({ user: admin, labels: {} })} />);
		fireEvent.click(screen.getByText("Val"));
		fireEvent.click(await screen.findByText("Platform console"));
		expect(assign).toHaveBeenCalledWith("/platform");

		const plain = {
			id: "u1",
			email: "bia@ktb.test",
			name: "Bia",
			patientOnly: false,
		};
		render(<SessionMenu {...props({ user: plain, labels: {} })} />);
		fireEvent.click(screen.getByText("Bia"));
		expect(screen.queryByText("Platform console")).toBeNull();
	});

	it("labels and routes a secretary-only account to its own portal", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		render(
			<SessionMenu
				{...props({
					user: {
						id: "s1",
						email: "sec@ktb.test",
						name: "Sec",
						patientOnly: false,
						clinicalRole: "secretary",
					},
					labels: { doctorPortal: "Portal do médico", secretaryPortal: "Portal da secretaria" },
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Sec"));
		expect(screen.queryByText("Portal do médico")).toBeNull();
		fireEvent.click(await screen.findByText("Portal da secretaria"));
		expect(assign).toHaveBeenCalledWith("/portal/secretary");
	});

	it("falls back to the English secretary label when the host fills none", async () => {
		render(
			<SessionMenu
				{...props({
					user: {
						id: "s1",
						email: "sec@ktb.test",
						name: "Sec",
						patientOnly: false,
						clinicalRole: "secretary",
					},
					labels: {},
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Sec"));
		expect(await screen.findByText("Secretary portal")).toBeTruthy();
	});

	it("falls back to English portal labels when the host fills none", async () => {
		render(
			<SessionMenu
				{...props({
					user: { id: "u1", email: "bia@ktb.test", name: "Bia", patientProfiles: 1 },
					labels: {},
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Bia"));
		expect(await screen.findByText("Doctor portal")).toBeTruthy();
		expect(screen.getByText("Patient portal")).toBeTruthy();
	});

	it("hides the patient portal when the account holds no patient record", async () => {
		render(
			<SessionMenu
				{...props({
					user: {
						id: "u1",
						email: "bia@ktb.test",
						name: "Bia",
						patientOnly: false,
						clinicalRole: "owner",
						patientProfiles: 0,
					},
					labels: {},
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Bia"));
		expect(await screen.findByText("Doctor portal")).toBeTruthy();
		expect(screen.queryByText("Patient portal")).toBeNull();
		expect(screen.queryByText("My consultations")).toBeNull();
	});

	it("also hides the patient portal when the count is unresolved", async () => {
		render(
			<SessionMenu
				{...props({
					user: { id: "u1", email: "bia@ktb.test", name: "Bia", clinicalRole: "owner" },
					labels: {},
				})}
			/>,
		);
		fireEvent.click(screen.getByText("Bia"));
		expect(await screen.findByText("Doctor portal")).toBeTruthy();
		expect(screen.queryByText("Patient portal")).toBeNull();
	});

	it("narrows a patient account to its own consultations", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		const user = {
			id: "p1",
			email: "ana@ktb.test",
			name: "Ana",
			patientOnly: true,
			patientProfiles: 2,
		};
		const view = render(
			<SessionMenu {...props({ user, labels: { myConsultations: "Minhas consultas" } })} />,
		);
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(await screen.findByText("Minhas consultas"));
		expect(assign).toHaveBeenCalledWith("/portal/patient");
		view.unmount();

		// No host label → English fallback; never the doctor shortcuts.
		render(<SessionMenu {...props({ user, labels: {} })} />);
		fireEvent.click(screen.getByText("Ana"));
		expect(await screen.findByText("My consultations")).toBeTruthy();
		expect(screen.queryByText("Switch doctor")).toBeNull();
		expect(screen.queryByText("Secretaries")).toBeNull();
		expect(screen.queryByText("Doctor portal")).toBeNull();
		expect(screen.queryByText("Patient portal")).toBeNull();
	});
});
