// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	listCredentialsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	createCredentialFn: vi.fn<(a?: Arg) => Res<{ id: string }>>(async () => ({
		ok: true,
		data: { id: "k2" },
	})),
	removeCredentialFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
}));
vi.mock("../fns.ts", () => fns);
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => void>() }),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { CredentialCard } from "../index.ts";
import { CredentialsPanelPage } from "../platform-page.tsx";
import { CredentialsPage } from "./CredentialsPage.tsx";

const cred: CredentialCard = {
	id: "k1",
	name: "prod key",
	provider: "openai",
	masked: "••••1234",
};

const ctx: PanelPageContext = { plugins: [], locale: "en" };

afterEach(cleanup);

describe("CredentialsPage", () => {
	it("renders the empty state", () => {
		render(<CredentialsPage creds={[]} locale="en" />);
		expect(screen.getByText(/No credentials yet/)).toBeTruthy();
	});

	it("lists credential cards with provider and mask", () => {
		render(<CredentialsPage creds={[cred]} locale="en" />);
		expect(screen.getByText("prod key")).toBeTruthy();
		expect(screen.getByText("openai")).toBeTruthy();
		expect(screen.getByText("••••1234")).toBeTruthy();
	});

	it("creates a credential through the dialog", async () => {
		const user = userEvent.setup();
		render(<CredentialsPage creds={[]} locale="en" />);
		await user.click(screen.getByText("New credential"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "my key");
		await user.click(screen.getByLabelText("Provider"));
		await user.click(await screen.findByRole("option", { name: "gemini" }));
		// The secret input is type=password — not a textbox role.
		const secret = document.querySelector("input[type=password]")!;
		await user.type(secret, "sekret-1");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(fns.createCredentialFn).toHaveBeenCalled());
		expect(fns.createCredentialFn.mock.calls[0]?.[0]?.data).toMatchObject({
			name: "my key",
			provider: "gemini",
			secret: "sekret-1",
		});
		await waitFor(() => expect(fns.listCredentialsFn).toHaveBeenCalled());
	});

	it("deletes after the confirm step", async () => {
		const user = userEvent.setup();
		render(<CredentialsPage creds={[cred]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByText("Confirm delete"));
		await waitFor(() =>
			expect(fns.removeCredentialFn).toHaveBeenCalledWith({ data: { id: "k1" } }),
		);
	});

	it("shows the failure message when save is denied", async () => {
		fns.createCredentialFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<CredentialsPage creds={[]} locale="en" />);
		await user.click(screen.getByText("New credential"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		const secret = document.querySelector("input[type=password]")!;
		await user.type(secret, "s");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText("Action failed")).toBeTruthy();
	});

	it("shows the failure message when delete is denied", async () => {
		fns.removeCredentialFn.mockResolvedValueOnce({ ok: false });
		const user = userEvent.setup();
		render(<CredentialsPage creds={[cred]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByText("Confirm delete"));
		expect(await screen.findByText("Action failed")).toBeTruthy();
	});

	it("cancels the dialog and keeps save disabled on empty fields", async () => {
		const user = userEvent.setup();
		render(<CredentialsPage creds={[]} locale="en" />);
		await user.click(screen.getByText("New credential"));
		expect(screen.getByText("Save")).toHaveProperty("disabled", true);
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes the dialog on Escape through onOpenChange", async () => {
		const user = userEvent.setup();
		render(<CredentialsPage creds={[]} locale="en" />);
		await user.click(screen.getByText("New credential"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("CredentialsPanelPage", () => {
	it("passes the loader array through and narrows anything else", () => {
		render(<CredentialsPanelPage data={[cred]} ctx={ctx} />);
		expect(screen.getByText("prod key")).toBeTruthy();

		cleanup();
		render(<CredentialsPanelPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No credentials yet/)).toBeTruthy();
	});
});
