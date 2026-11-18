// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelsApi } from "../apis.ts";
import type { ModelCard } from "../models.ts";
import { ModelsPage } from "./ModelsPage.tsx";

const card = (over: Partial<ModelCard> = {}): ModelCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	endpointId: null,
	name: "local-qwen",
	modelId: "qwen2.5:7b",
	kind: "chat",
	capabilities: ["chat"],
	contextTokens: null,
	costTier: null,
	isDefault: false,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
	...over,
});

const makeApi = () => ({
	create: vi.fn<ModelsApi["create"]>(async (input) => ({
		ok: true as const,
		data: card({
			id: 99,
			name: input.name,
			modelId: input.modelId,
			endpointId: input.endpointId ?? null,
			kind: (input.kind as ModelCard["kind"]) ?? "chat",
			capabilities: input.capabilities ?? [],
			contextTokens: input.contextTokens ?? null,
			costTier: input.costTier ?? null,
			isDefault: input.isDefault ?? false,
		}),
	})),
	update: vi.fn<ModelsApi["update"]>(async (input) => ({
		ok: true as const,
		data: card({ id: input.id, name: input.name ?? "x", enabled: input.enabled ?? true }),
	})),
	remove: vi.fn<ModelsApi["remove"]>(async () => ({ ok: true as const })),
});

afterEach(cleanup);

describe("ModelsPage", () => {
	it("renders the empty state", () => {
		render(<ModelsPage models={[]} api={makeApi()} locale="en" />);
		expect(screen.getByText(/No models yet/)).toBeTruthy();
	});

	it("lists models with kind tone, endpoint, default star and enabled mark", () => {
		render(
			<ModelsPage
				models={[
					card({ id: 1, name: "alpha", modelId: "m-alpha", endpointId: 4, isDefault: true }),
					card({ id: 2, name: "beta", modelId: "m-beta", kind: "other", enabled: false }),
				]}
				api={makeApi()}
				locale="en"
			/>,
		);
		expect(screen.getByText("alpha")).toBeTruthy();
		expect(screen.getByText("m-alpha")).toBeTruthy();
		expect(screen.getByText("4")).toBeTruthy();
		expect(screen.getByText("★")).toBeTruthy();
		expect(screen.getByText("other")).toBeTruthy();
		// beta has no endpointId and is disabled — both render "—".
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("creates a model through the dialog with every field", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<ModelsPage models={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));

		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "new-model");
		await user.type(inputs[1]!, "provider/model-id");
		await user.type(inputs[2]!, "12"); // endpointId
		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "vision" }));
		await user.type(inputs[3]!, "chat, vision"); // capabilities
		await user.type(inputs[4]!, "32768"); // contextTokens
		await user.type(inputs[5]!, "low"); // costTier
		await user.click(screen.getByLabelText("Default"));
		await user.click(screen.getByText("Save"));

		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "new-model",
			modelId: "provider/model-id",
			endpointId: 12,
			kind: "vision",
			capabilities: ["chat", "vision"],
			contextTokens: 32768,
			costTier: "low",
			isDefault: true,
		});
		// The returned card is merged into the list.
		expect(await screen.findByText("new-model")).toBeTruthy();
	});

	it("creates with only required fields — optionals stay off the wire", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<ModelsPage models={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "minimal");
		await user.type(inputs[1]!, "m-min");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "minimal",
			modelId: "m-min",
			kind: "chat",
			isDefault: false,
		});
	});

	it("edits an existing model — prefilled draft, enabled toggle on the wire", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<ModelsPage
				models={[
					card({
						id: 7,
						name: "edit-me",
						modelId: "m-edit",
						endpointId: 3,
						kind: "asr",
						capabilities: ["asr", "chat"],
						contextTokens: 16000,
						costTier: "high",
						enabled: true,
					}),
				]}
				api={api}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("Edit model"));
		// Prefilled from the card.
		const inputs = screen.getAllByRole("textbox");
		expect((inputs[0] as HTMLInputElement).value).toBe("edit-me");
		expect((inputs[1] as HTMLInputElement).value).toBe("m-edit");
		expect((inputs[2] as HTMLInputElement).value).toBe("3");
		expect((inputs[3] as HTMLInputElement).value).toBe("asr, chat");
		expect((inputs[4] as HTMLInputElement).value).toBe("16000");
		expect((inputs[5] as HTMLInputElement).value).toBe("high");
		// The enabled checkbox only renders for existing rows.
		const enabledBox = screen.getByLabelText("Enabled") as HTMLInputElement;
		expect(enabledBox.checked).toBe(true);
		await user.click(enabledBox);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.update).toHaveBeenCalled());
		expect(api.update.mock.calls[0]?.[0]).toMatchObject({
			id: 7,
			name: "edit-me",
			modelId: "m-edit",
			endpointId: 3,
			kind: "asr",
			capabilities: ["asr", "chat"],
			contextTokens: 16000,
			costTier: "high",
			enabled: false,
		});
	});

	it("shows the error line when a mutation fails", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.create.mockResolvedValueOnce({ ok: false });
		render(<ModelsPage models={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		await user.type(inputs[1]!, "y");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("treats a missing payload as a failure too", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.create.mockResolvedValueOnce({ ok: true });
		render(<ModelsPage models={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		await user.type(inputs[1]!, "y");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("deletes a model after the confirm step; cancel keeps it", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<ModelsPage models={[card({ id: 5, name: "doomed" })]} api={api} locale="en" />);

		// Cancel path — dialog closes, nothing is removed.
		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Cancel"));
		expect(api.remove).not.toHaveBeenCalled();
		expect(screen.getByText("doomed")).toBeTruthy();

		// Confirm path — the dialog's confirm button shares the "Delete"
		// label, so target it by its data-slot.
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		await waitFor(() => expect(api.remove).toHaveBeenCalledWith(5));
		await waitFor(() => expect(screen.queryByText("doomed")).toBeNull());
	});

	it("surfaces remove failures", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.remove.mockResolvedValueOnce({ ok: false });
		render(<ModelsPage models={[card({ id: 6, name: "stuck" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
		expect(screen.getByText("stuck")).toBeTruthy();
	});

	it("sorts the merged list by name on create", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<ModelsPage models={[card({ id: 1, name: "zzz" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "aaa");
		await user.type(inputs[1]!, "m-aaa");
		await user.click(screen.getByText("Save"));
		await screen.findByText("aaa");
		const names = screen.getAllByRole("row").map((r) => r.textContent ?? "");
		expect(names[1]).toContain("aaa");
		expect(names[2]).toContain("zzz");
	});

	it("prefills empty strings for null optional fields when editing", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<ModelsPage
				models={[
					card({ id: 8, name: "sparse", endpointId: null, contextTokens: null, costTier: null }),
				]}
				api={api}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("Edit model"));
		const inputs = screen.getAllByRole("textbox");
		expect((inputs[2] as HTMLInputElement).value).toBe("");
		expect((inputs[4] as HTMLInputElement).value).toBe("");
		expect((inputs[5] as HTMLInputElement).value).toBe("");
	});

	it("closes the editor via Cancel and via Escape", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<ModelsPage models={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add model"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByText("Model ID")).toBeNull();

		await user.click(screen.getByText("Add model"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByText("Model ID")).toBeNull());
	});
});
