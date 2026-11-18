// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PromptsApi } from "../apis.ts";
import type { PromptCard } from "../prompts.ts";
import { PromptsPage } from "./PromptsPage.tsx";

const prompt = (over: Partial<PromptCard> = {}): PromptCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "anamnesis.extract",
	version: 1,
	locale: "",
	template: "Extract the anamnesis from {transcript}.",
	variables: [{ name: "transcript", required: true }],
	modelHint: null,
	isSystem: true,
	isDefault: false,
	enabled: true,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: null,
	...over,
});

const api = (): PromptsApi & {
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} => ({
	create: vi.fn(async (input: { name: string }) => ({
		ok: true,
		data: prompt({ id: 99, name: input.name }),
	})),
	update: vi.fn(async (input: { id: number }) => ({ ok: true, data: prompt({ id: input.id }) })),
	remove: vi.fn(async () => ({ ok: true })),
});

afterEach(cleanup);

describe("PromptsPage", () => {
	it("renders the empty state", () => {
		render(<PromptsPage prompts={[]} api={api()} locale="en" />);
		expect(screen.getByText("No prompts yet — seed the first registry entry.")).toBeTruthy();
	});

	it("renders prompt rows with flags, locale fallback and actions", () => {
		const rows = [
			prompt(),
			prompt({
				id: 2,
				name: "eval.judge",
				version: 3,
				locale: "pt-BR",
				isSystem: false,
				isDefault: true,
				enabled: false,
				modelHint: "kind:judge",
			}),
		];
		render(<PromptsPage prompts={rows} api={api()} locale="en" />);
		expect(screen.getByText("anamnesis.extract")).toBeTruthy();
		expect(screen.getByText("eval.judge")).toBeTruthy();
		expect(screen.getByText("v3")).toBeTruthy();
		expect(screen.getByText("pt-BR")).toBeTruthy();
		// Empty locale renders the em-dash; disabled renders "—" too.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
		expect(screen.getByText("★")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "New version" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
	});

	it("creates a prompt through the dialog with every field", async () => {
		const a = api();
		render(<PromptsPage prompts={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.type(screen.getByPlaceholderText("anamnesis.extract"), "new.prompt");
		await userEvent.type(screen.getByPlaceholderText("auto"), "4");
		await userEvent.type(screen.getByPlaceholderText("pt-BR"), "es");
		await userEvent.type(screen.getByLabelText("Template"), "Hello visitor");
		await userEvent.type(screen.getByLabelText("Model hint"), "kind:chat");
		await userEvent.click(screen.getByLabelText("System prompt"));
		await userEvent.click(screen.getByLabelText("Default"));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "new.prompt",
				template: "Hello visitor",
				version: 4,
				locale: "es",
				modelHint: "kind:chat",
				isSystem: true,
				isDefault: true,
			}),
		);
	});

	it("creates with minimal fields — empty optionals are omitted", async () => {
		const a = api();
		render(<PromptsPage prompts={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.type(screen.getByPlaceholderText("anamnesis.extract"), "minimal");
		await userEvent.type(screen.getByLabelText("Template"), "plain template");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "minimal",
				template: "plain template",
				isSystem: false,
				isDefault: false,
			}),
		);
	});

	it("edits an existing version — name/version/locale locked, enabled editable", async () => {
		const a = api();
		render(<PromptsPage prompts={[prompt({ modelHint: "kind:chat" })]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(screen.getByText("Edit — v1")).toBeTruthy();
		// Identity fields are not rendered for edits.
		expect(screen.queryByPlaceholderText("anamnesis.extract")).toBeNull();
		await userEvent.clear(screen.getByLabelText("Template"));
		await userEvent.type(screen.getByLabelText("Template"), "edited template");
		await userEvent.click(screen.getByLabelText("Enabled"));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith({
				id: 1,
				template: "edited template",
				modelHint: "kind:chat",
				isSystem: true,
				isDefault: false,
				enabled: false,
			}),
		);
		expect(a.create).not.toHaveBeenCalled();
	});

	it("edit without a model hint omits the field from the payload", async () => {
		const a = api();
		render(<PromptsPage prompts={[prompt()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith({
				id: 1,
				template: "Extract the anamnesis from {transcript}.",
				isSystem: true,
				isDefault: false,
				enabled: true,
			}),
		);
	});

	it("re-sorts the row set after a successful save", async () => {
		const a = api();
		const rows = [
			prompt({ id: 1, name: "aaa.prompt", version: 1 }),
			prompt({ id: 2, name: "aaa.prompt", version: 2 }),
			prompt({ id: 3, name: "zzz.prompt", version: 1 }),
		];
		a.update.mockResolvedValue({
			ok: true,
			data: prompt({ id: 1, name: "aaa.prompt", version: 1, template: "t2" }),
		});
		render(<PromptsPage prompts={rows} api={a} locale="en" />);
		const editButtons = screen.getAllByRole("button", { name: "Edit" });
		await userEvent.click(editButtons[0]!);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(a.update).toHaveBeenCalled());
		// name asc, then version desc: aaa v2, aaa v1, zzz.
		const names = screen.getAllByText(/\.prompt$/).map((el) => el.textContent);
		expect(names).toEqual(["aaa.prompt", "aaa.prompt", "zzz.prompt"]);
		const versions = screen.getAllByText(/^v\d+$/).map((el) => el.textContent);
		expect(versions).toEqual(["v2", "v1", "v1"]);
	});

	it("new-version prefills name/locale/system and creates a fresh draft", async () => {
		const a = api();
		render(
			<PromptsPage prompts={[prompt({ locale: "pt-BR", isSystem: true })]} api={a} locale="en" />,
		);
		await userEvent.click(screen.getByRole("button", { name: "New version" }));
		await userEvent.type(screen.getByLabelText("Template"), "v2 template");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith({
				name: "anamnesis.extract",
				template: "v2 template",
				locale: "pt-BR",
				isSystem: true,
				isDefault: false,
			}),
		);
	});

	it("escape closes the dialog without saving", async () => {
		const a = api();
		render(<PromptsPage prompts={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByPlaceholderText("anamnesis.extract")).toBeNull());
		expect(a.create).not.toHaveBeenCalled();
	});

	it("cancel closes the dialog without saving", async () => {
		const a = api();
		render(<PromptsPage prompts={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByPlaceholderText("anamnesis.extract")).toBeNull());
		expect(a.create).not.toHaveBeenCalled();
	});

	it("surfaces the error when save fails or returns no data", async () => {
		const a = api();
		a.create.mockResolvedValue({ ok: false });
		render(<PromptsPage prompts={[]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.type(screen.getByPlaceholderText("anamnesis.extract"), "fail.prompt");
		await userEvent.type(screen.getByLabelText("Template"), "t");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
		// ok:true without a card also degrades to the error path.
		a.create.mockResolvedValue({ ok: true });
		await userEvent.click(screen.getByRole("button", { name: "Add prompt" }));
		await userEvent.type(screen.getByPlaceholderText("anamnesis.extract"), "nodata");
		await userEvent.type(screen.getByLabelText("Template"), "t");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
	});

	it("deletes through the confirm dialog and drops the row", async () => {
		const a = api();
		render(<PromptsPage prompts={[prompt()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(
			screen.getByText("Delete this prompt version? Consumers pinned to it will resolve null."),
		).toBeTruthy();
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() => expect(screen.queryByText("anamnesis.extract")).toBeNull());
	});

	it("delete failure keeps the row and surfaces the error", async () => {
		const a = api();
		a.remove.mockResolvedValue({ ok: false });
		render(<PromptsPage prompts={[prompt()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
		await userEvent.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1));
		await waitFor(() =>
			expect(screen.getByText("Action failed — check permissions and try again.")).toBeTruthy(),
		);
		expect(screen.getByText("anamnesis.extract")).toBeTruthy();
	});

	it("confirm-dialog cancel dismisses without deleting", async () => {
		const a = api();
		render(<PromptsPage prompts={[prompt()]} api={a} locale="en" />);
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(
				screen.queryByText("Delete this prompt version? Consumers pinned to it will resolve null."),
			).toBeNull(),
		);
		expect(a.remove).not.toHaveBeenCalled();
	});

	it("localizes chrome copy", () => {
		render(<PromptsPage prompts={[]} api={api()} locale="pt-BR" />);
		expect(screen.getByText("Prompts de IA")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Adicionar prompt" })).toBeTruthy();
	});
});
