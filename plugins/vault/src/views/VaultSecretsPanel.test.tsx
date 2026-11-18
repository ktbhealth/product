// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretMeta } from "../secrets.ts";
import { VaultSecretsPanel, type VaultSecretsApi } from "./VaultSecretsPanel.tsx";

const secret = (over: Partial<SecretMeta> = {}): SecretMeta => ({
	id: 1,
	scope: "7",
	tenantId: 7,
	name: "openai-prod",
	provider: "openai",
	kind: "api-key",
	hint: "sk-...1234",
	version: 2,
	status: "active",
	kekVersion: "env:abc",
	createdBy: "u1",
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: new Date("2026-11-02T10:00:00Z"),
	rotatedAt: null,
	...over,
});

const api = (): VaultSecretsApi & {
	put: ReturnType<typeof vi.fn>;
	rotate: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} => ({
	put: vi.fn(async () => ({ ok: true })),
	rotate: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
});

const renderPanel = (
	secrets: readonly SecretMeta[],
	canManage: boolean,
	a: VaultSecretsApi,
	onChanged = vi.fn(),
) =>
	render(
		<VaultSecretsPanel secrets={secrets} canManage={canManage} api={a} onChanged={onChanged} />,
	);

afterEach(cleanup);

describe("VaultSecretsPanel", () => {
	it("renders the empty state and hides management for non-admins", () => {
		renderPanel([], false, api());
		expect(screen.getByText("No secrets stored yet.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Add secret" })).toBeNull();
	});

	it("renders rows with provider fallback and version", () => {
		renderPanel(
			[
				secret(),
				secret({
					id: 2,
					name: "smtp-main",
					provider: null,
					kind: "password",
					version: 1,
					updatedAt: null,
					createdAt: "bad-date" as unknown as Date,
				}),
			],
			true,
			api(),
		);
		expect(screen.getByText("openai-prod")).toBeTruthy();
		expect(screen.getByText("openai")).toBeTruthy();
		expect(screen.getByText("smtp-main")).toBeTruthy();
		// null provider → em-dash; invalid date → em-dash.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("hides row actions for non-admin members", () => {
		renderPanel([secret()], false, api());
		expect(screen.getByText("openai-prod")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("adds a secret through the dialog and notifies onChanged", async () => {
		const a = api();
		const onChanged = vi.fn();
		renderPanel([], true, a, onChanged);
		await userEvent.click(screen.getByRole("button", { name: "Add secret" }));
		await userEvent.type(screen.getByLabelText("Name"), "  new-key  ");
		await userEvent.type(screen.getByLabelText("Provider"), " anthropic ");
		await userEvent.selectOptions(screen.getByLabelText("Kind"), "token");
		await userEvent.type(screen.getByLabelText("Secret value"), "s3cr3t");
		const addButtons = screen.getAllByRole("button", { name: "Add secret" });
		await userEvent.click(addButtons[addButtons.length - 1]!);
		await waitFor(() =>
			expect(a.put).toHaveBeenCalledWith({
				name: "new-key",
				value: "s3cr3t",
				provider: "anthropic",
				kind: "token",
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("keeps the dialog open and shows the error when put fails", async () => {
		const a = api();
		a.put.mockResolvedValue({ ok: false });
		renderPanel([], true, a);
		await userEvent.click(screen.getByRole("button", { name: "Add secret" }));
		await userEvent.type(screen.getByLabelText("Name"), "fail");
		await userEvent.type(screen.getByLabelText("Secret value"), "x");
		const addButtons = screen.getAllByRole("button", { name: "Add secret" });
		await userEvent.click(addButtons[addButtons.length - 1]!);
		await waitFor(() => expect(screen.getByText("The action failed — try again.")).toBeTruthy());
		expect(screen.getByLabelText("Name")).toBeTruthy();
	});

	it("escape closes the add dialog via onOpenChange", async () => {
		const a = api();
		renderPanel([], true, a);
		await userEvent.click(screen.getByRole("button", { name: "Add secret" }));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
		expect(a.put).not.toHaveBeenCalled();
	});

	it("cancel closes the add dialog without saving", async () => {
		const a = api();
		renderPanel([], true, a);
		await userEvent.click(screen.getByRole("button", { name: "Add secret" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
		expect(a.put).not.toHaveBeenCalled();
	});

	it("rotates a secret through the confirm dialog", async () => {
		const a = api();
		const onChanged = vi.fn();
		renderPanel([secret()], true, a, onChanged);
		await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Rotate" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.rotate).toHaveBeenCalledWith(1));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("rotate failure keeps the dialog result as an error", async () => {
		const a = api();
		a.rotate.mockResolvedValue({ ok: false });
		renderPanel([secret()], true, a);
		await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Rotate" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(screen.getByText("The action failed — try again.")).toBeTruthy());
	});

	it("removes a secret through the destructive confirm dialog", async () => {
		const a = api();
		const onChanged = vi.fn();
		renderPanel([secret()], true, a, onChanged);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("remove failure surfaces the error without closing early", async () => {
		const a = api();
		a.remove.mockResolvedValue({ ok: false });
		const onChanged = vi.fn();
		renderPanel([secret()], true, a, onChanged);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(screen.getByText("The action failed — try again.")).toBeTruthy());
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("confirm-dialog cancel dismisses without rotating", async () => {
		const a = api();
		renderPanel([secret()], true, a);
		await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText(/Rotate secret/i)).toBeNull());
		expect(a.rotate).not.toHaveBeenCalled();
	});
});
