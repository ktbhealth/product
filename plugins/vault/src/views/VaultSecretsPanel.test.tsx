// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretMeta } from "../secrets.ts";
import { VaultSecretsPanel, type VaultSecretsApi } from "./VaultSecretsPanel.tsx";

const meta = (over: Partial<SecretMeta> = {}): SecretMeta => ({
	id: 1,
	scope: "7",
	tenantId: 7,
	name: "openai-prod",
	provider: "openai",
	kind: "api-key",
	hint: "-1",
	kekVersion: null,
	status: "active",
	version: 1,
	createdBy: "u1",
	createdAt: new Date("2025-01-02T03:04:05Z"),
	updatedAt: null,
	rotatedAt: null,
	...over,
});

const makeApi = () => ({
	put: vi.fn<VaultSecretsApi["put"]>(async (input) => ({
		ok: true as const,
		data: meta({ name: input.name, provider: input.provider ?? null }),
	})),
	rotate: vi.fn<VaultSecretsApi["rotate"]>(async () => ({ ok: true as const })),
	remove: vi.fn<VaultSecretsApi["remove"]>(async () => ({ ok: true as const })),
});

afterEach(cleanup);

describe("VaultSecretsPanel", () => {
	it("renders rows for members without manage controls", () => {
		render(
			<VaultSecretsPanel
				secrets={[
					meta({ id: 1, name: "read-only-secret" }),
					// createdAt null → both date fallbacks collapse to "—".
					meta({ id: 2, name: "no-dates", createdAt: null as never, updatedAt: null }),
				]}
				canManage={false}
				api={makeApi()}
				locale="en"
				onChanged={() => {}}
			/>,
		);
		expect(screen.getByText("read-only-secret")).toBeTruthy();
		expect(screen.getByText("no-dates")).toBeTruthy();
		expect(screen.queryByText("Add secret")).toBeNull();
		expect(screen.queryByText("Rotate")).toBeNull();
		expect(screen.queryByText("Delete")).toBeNull();
	});

	it("lists metadata — provider dash, kind, version, dates — never values", () => {
		render(
			<VaultSecretsPanel
				secrets={[
					meta({ id: 1, name: "alpha", provider: "openai" }),
					meta({
						id: 2,
						name: "beta",
						provider: null,
						kind: "token",
						version: 3,
						updatedAt: new Date("2025-02-01T00:00:00Z"),
					}),
					meta({
						id: 3,
						name: "gamma",
						provider: "aws",
						createdAt: "not-a-date" as unknown as Date,
						updatedAt: null,
					}),
				]}
				canManage
				api={makeApi()}
				locale="en"
				onChanged={() => {}}
			/>,
		);
		expect(screen.getByText("alpha")).toBeTruthy();
		expect(screen.getByText("beta")).toBeTruthy();
		expect(screen.getByText("openai")).toBeTruthy();
		expect(screen.getByText("token")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
		// null provider renders the dash; invalid date renders the dash.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
		expect(screen.getAllByText("Rotate").length).toBe(3);
	});

	it("adds a secret through the dialog — provider empty becomes null", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		const onChanged = vi.fn();
		render(
			<VaultSecretsPanel secrets={[]} canManage api={api} locale="en" onChanged={onChanged} />,
		);
		await user.click(screen.getByText("Add secret"));

		const nameInput = screen.getByLabelText("Name");
		const providerInput = screen.getByLabelText("Provider");
		const valueInput = screen.getByLabelText("Secret value");
		const save = screen.getAllByText("Add secret").at(-1)!;
		expect(save).toHaveProperty("disabled", true); // name+value empty

		await user.type(nameInput, "  smtp-main  ");
		await user.type(providerInput, "  ");
		await user.selectOptions(screen.getByLabelText("Kind"), "password");
		await user.type(valueInput, "pw-123");
		await user.click(save);

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(api.put.mock.calls[0]?.[0]).toEqual({
			name: "smtp-main",
			value: "pw-123",
			provider: null,
			kind: "password",
		});
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("keeps provider text when provided and resets the form on success", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<VaultSecretsPanel secrets={[]} canManage api={api} locale="en" onChanged={() => {}} />);
		await user.click(screen.getByText("Add secret"));
		await user.type(screen.getByLabelText("Name"), "k1");
		await user.type(screen.getByLabelText("Provider"), "openai");
		await user.type(screen.getByLabelText("Secret value"), "v");
		await user.click(screen.getAllByText("Add secret").at(-1)!);
		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(api.put.mock.calls[0]?.[0]).toMatchObject({ provider: "openai" });
		// Dialog closed after success.
		await waitFor(() => expect(screen.queryByLabelText("Secret value")).toBeNull());
	});

	it("surfaces put failures and keeps the dialog open", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.put.mockResolvedValueOnce({ ok: false });
		render(<VaultSecretsPanel secrets={[]} canManage api={api} locale="en" onChanged={() => {}} />);
		await user.click(screen.getByText("Add secret"));
		await user.type(screen.getByLabelText("Name"), "x");
		await user.type(screen.getByLabelText("Secret value"), "y");
		await user.click(screen.getAllByText("Add secret").at(-1)!);
		expect(await screen.findByText(/failed/i)).toBeTruthy();
		expect(screen.getByLabelText("Secret value")).toBeTruthy();
	});

	it("closes the add dialog via Cancel and Escape", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<VaultSecretsPanel secrets={[]} canManage api={api} locale="en" onChanged={() => {}} />);
		await user.click(screen.getByText("Add secret"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByLabelText("Secret value")).toBeNull();

		await user.click(screen.getByText("Add secret"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Secret value")).toBeNull());
	});

	it("rotates a secret after confirm; cancel and failure paths", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		const onChanged = vi.fn();
		render(
			<VaultSecretsPanel
				secrets={[meta({ id: 4, name: "rot-me" })]}
				canManage
				api={api}
				locale="en"
				onChanged={onChanged}
			/>,
		);
		// Cancel keeps the dialog closed.
		await user.click(screen.getByText("Rotate"));
		await user.click(screen.getByText("Cancel"));
		expect(api.rotate).not.toHaveBeenCalled();

		// Confirm rotates and refreshes.
		await user.click(screen.getByText("Rotate"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		await waitFor(() => expect(api.rotate).toHaveBeenCalledWith(4));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());

		// Failure surfaces the error line.
		api.rotate.mockResolvedValueOnce({ ok: false });
		await user.click(screen.getByText("Rotate"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		expect(await screen.findByText(/failed/i)).toBeTruthy();
	});

	it("removes a secret after confirm; failure keeps it listed", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		const onChanged = vi.fn();
		render(
			<VaultSecretsPanel
				secrets={[meta({ id: 5, name: "doomed" })]}
				canManage
				api={api}
				locale="en"
				onChanged={onChanged}
			/>,
		);
		// Cancel path.
		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Cancel"));
		expect(api.remove).not.toHaveBeenCalled();

		// Failure path — the dialog stays open on failure.
		api.remove.mockResolvedValueOnce({ ok: false });
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		expect(await screen.findByText(/failed/i)).toBeTruthy();
		expect(screen.getByText("doomed")).toBeTruthy();

		// The dialog auto-closes after confirm; retry for the success path.
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		await waitFor(() => expect(api.remove).toHaveBeenCalledWith(5));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});
});
