// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelsApi } from "../apis.ts";
import type { ModelCard } from "../models.ts";
import { ModelsPage } from "./ModelsPage.tsx";

const model = (over: Partial<ModelCard> = {}): ModelCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	endpointId: 3,
	name: "local-qwen",
	modelId: "qwen2.5:7b-instruct",
	kind: "chat",
	capabilities: ["chat", "eval-judge"],
	contextTokens: 32_768,
	costTier: "free",
	isDefault: true,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

const api = (): ModelsApi & {
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} => ({
	create: vi.fn(async () => ({ ok: true })),
	update: vi.fn(async () => ({ ok: true })),
	remove: vi.fn(async () => ({ ok: true })),
});

afterEach(cleanup);

describe("ModelsPage", () => {
	it("renders the empty state", () => {
		render(<ModelsPage models={[]} api={api()} locale="en" />);
		expect(screen.getByText("No models yet — add the first catalog entry.")).toBeTruthy();
	});

	it("renders model rows with metadata and actions", () => {
		const sparse = model({
			id: 2,
			name: "tiny-asr",
			modelId: "whisper-tiny",
			kind: "asr",
			endpointId: null,
			capabilities: [],
			contextTokens: null,
			costTier: null,
			isDefault: false,
			enabled: false,
		});
		render(<ModelsPage models={[model(), sparse]} api={api()} locale="en" />);
		expect(screen.getByText("local-qwen")).toBeTruthy();
		expect(screen.getByText("qwen2.5:7b-instruct")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
		expect(screen.getByText("★")).toBeTruthy();
		expect(screen.getByText("tiny-asr")).toBeTruthy();
		// null endpoint renders the em-dash fallback; disabled row too.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Edit model").length).toBe(2);
		expect(screen.getAllByText("Delete").length).toBe(2);
	});

	it("creates a model through the dialog with every field", async () => {
		const a = api();
		const created = model({ id: 9, name: "aaa-first" });
		a.create.mockResolvedValue({ ok: true, data: created });
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.type(screen.getByLabelText("Name"), "aaa-first");
		await userEvent.type(screen.getByLabelText("Model ID"), "provider/aaa");
		await userEvent.type(screen.getByLabelText("Endpoint"), "7");
		await userEvent.selectOptions(screen.getByLabelText("Kind"), "vision");
		await userEvent.type(screen.getByLabelText("Capabilities"), "chat, vision");
		await userEvent.type(screen.getByLabelText("Context tokens"), "8192");
		await userEvent.type(screen.getByLabelText("Cost tier"), "low");
		await userEvent.click(screen.getByLabelText("Default"));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "aaa-first",
				modelId: "provider/aaa",
				endpointId: 7,
				kind: "vision",
				capabilities: ["chat", "vision"],
				contextTokens: 8192,
				costTier: "low",
				isDefault: true,
			}),
		);
		// Successful create merges the returned card into the sorted rows.
		await waitFor(() => expect(screen.getAllByText("aaa-first").length).toBe(1));
	});

	it("creates with minimal fields — optional inputs stay absent", async () => {
		const a = api();
		a.create.mockResolvedValue({ ok: true, data: model({ id: 8, name: "minimal" }) });
		render(<ModelsPage models={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.type(screen.getByLabelText("Name"), "minimal");
		await userEvent.type(screen.getByLabelText("Model ID"), "m/min");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "minimal",
				modelId: "m/min",
				kind: "chat",
				isDefault: false,
			}),
		);
	});

	it("surfaces the action error when create fails or returns no card", async () => {
		const a = api();
		a.create.mockResolvedValue({ ok: false });
		render(<ModelsPage models={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.type(screen.getByLabelText("Name"), "fail-model");
		await userEvent.type(screen.getByLabelText("Model ID"), "m/fail");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
		cleanup();

		// ok without a card also degrades to the error path.
		const b = api();
		b.create.mockResolvedValue({ ok: true });
		render(<ModelsPage models={[]} api={b} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.type(screen.getByLabelText("Name"), "nodata");
		await userEvent.type(screen.getByLabelText("Model ID"), "m/nodata");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
	});

	it("escape closes the dialog without saving", async () => {
		const a = api();
		render(<ModelsPage models={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
		expect(a.create).not.toHaveBeenCalled();
	});

	it("cancel closes the create dialog without saving", async () => {
		const a = api();
		render(<ModelsPage models={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add model" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
		expect(a.create).not.toHaveBeenCalled();
	});

	it("edits a fully-populated model and submits every field", async () => {
		const a = api();
		const updated = model({ name: "local-qwen-2", enabled: false });
		a.update.mockResolvedValue({ ok: true, data: updated });
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Edit model" }));
		// Row button + dialog title both read "Edit model".
		expect(screen.getAllByText("Edit model").length).toBeGreaterThanOrEqual(2);
		const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
		expect(nameInput.value).toBe("local-qwen");
		const enabledBox = screen.getByLabelText("Enabled") as HTMLInputElement;
		expect(enabledBox.checked).toBe(true);
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "local-qwen-2");
		await userEvent.click(enabledBox);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith({
				id: 1,
				name: "local-qwen-2",
				modelId: "qwen2.5:7b-instruct",
				endpointId: 3,
				kind: "chat",
				capabilities: ["chat", "eval-judge"],
				contextTokens: 32_768,
				costTier: "free",
				isDefault: true,
				enabled: false,
			}),
		);
		await waitFor(() => expect(screen.getByText("local-qwen-2")).toBeTruthy());
	});

	it("edits a sparse model — null fields stay absent from the payload", async () => {
		const a = api();
		const sparse = model({
			id: 2,
			name: "tiny-asr",
			modelId: "whisper-tiny",
			kind: "asr",
			endpointId: null,
			capabilities: [],
			contextTokens: null,
			costTier: null,
			isDefault: false,
			enabled: false,
		});
		a.update.mockResolvedValue({ ok: true, data: sparse });
		render(<ModelsPage models={[sparse]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Edit model" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith({
				id: 2,
				name: "tiny-asr",
				modelId: "whisper-tiny",
				kind: "asr",
				isDefault: false,
				enabled: false,
			}),
		);
	});

	it("surfaces the action error when update fails", async () => {
		const a = api();
		a.update.mockResolvedValue({ ok: false });
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Edit model" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
	});

	it("deletes through the confirm dialog and removes the row", async () => {
		const a = api();
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(
			screen.getByText("Delete this model? Consumers resolving it will get null."),
		).toBeTruthy();
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() => expect(screen.queryByText("local-qwen")).toBeNull());
	});

	it("keeps the row and surfaces the error when remove fails", async () => {
		const a = api();
		a.remove.mockResolvedValue({ ok: false });
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
		expect(screen.getByText("local-qwen")).toBeTruthy();
	});

	it("confirm-dialog cancel dismisses without deleting", async () => {
		const a = api();
		render(<ModelsPage models={[model()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(
				screen.queryByText("Delete this model? Consumers resolving it will get null."),
			).toBeNull(),
		);
		expect(a.remove).not.toHaveBeenCalled();
	});

	it("renders localized chrome", () => {
		render(<ModelsPage models={[]} api={api()} locale="pt-BR" />);
		expect(screen.getByText("Modelos de IA")).toBeTruthy();
		expect(
			screen.getByText("Nenhum modelo ainda — adicione a primeira entrada do catálogo."),
		).toBeTruthy();
	});
});
