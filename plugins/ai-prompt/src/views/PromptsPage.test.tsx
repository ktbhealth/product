// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PromptsApi } from "../apis.ts";
import type { PromptCard } from "../prompts.ts";
import { PromptsPage } from "./PromptsPage.tsx";

const card = (over: Partial<PromptCard> = {}): PromptCard => ({
	id: 1,
	scope: "platform",
	tenantId: null,
	name: "anamnesis.extract",
	version: 1,
	locale: "",
	template: "Extract the anamnesis.",
	variables: [],
	modelHint: null,
	isSystem: false,
	isDefault: false,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
	...over,
});

const makeApi = () => ({
	create: vi.fn<PromptsApi["create"]>(async (input) => ({
		ok: true as const,
		data: card({
			id: 99,
			name: input.name,
			version: input.version ?? 1,
			locale: input.locale ?? "",
			template: input.template,
			variables: input.variables ?? [],
			modelHint: input.modelHint ?? null,
			isSystem: input.isSystem ?? false,
			isDefault: input.isDefault ?? false,
		}),
	})),
	update: vi.fn<PromptsApi["update"]>(async (input) => ({
		ok: true as const,
		data: card({
			id: input.id,
			template: input.template ?? "x",
			isSystem: input.isSystem ?? false,
			isDefault: input.isDefault ?? false,
			enabled: input.enabled ?? true,
		}),
	})),
	remove: vi.fn<PromptsApi["remove"]>(async () => ({ ok: true as const })),
});

afterEach(cleanup);

describe("PromptsPage", () => {
	it("renders the empty state", () => {
		render(<PromptsPage prompts={[]} api={makeApi()} locale="en" />);
		expect(screen.getByText(/No prompts yet/)).toBeTruthy();
	});

	it("lists prompts with version, locale dash, flags and enabled mark", () => {
		render(
			<PromptsPage
				prompts={[
					card({
						id: 1,
						name: "alpha",
						version: 2,
						locale: "pt-BR",
						isSystem: true,
						isDefault: true,
					}),
					card({ id: 2, name: "beta", version: 1, enabled: false }),
				]}
				api={makeApi()}
				locale="en"
			/>,
		);
		expect(screen.getByText("alpha")).toBeTruthy();
		expect(screen.getByText("v2")).toBeTruthy();
		expect(screen.getByText("pt-BR")).toBeTruthy();
		expect(screen.getByText("★")).toBeTruthy();
		expect(screen.getByText("beta")).toBeTruthy();
		// Neutral locale renders the em-dash; disabled enabled-flag too.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("creates a prompt with every field through the dialog", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<PromptsPage prompts={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add prompt"));

		const inputs = screen.getAllByRole("textbox");
		// name, version, locale, template (textarea), modelHint
		await user.type(inputs[0]!, "new.prompt");
		await user.type(inputs[1]!, "3");
		await user.type(inputs[2]!, "es");
		await user.type(inputs[3]!, "Template body");
		await user.type(inputs[4]!, "judge-kind");
		await user.click(screen.getByLabelText("System prompt"));
		await user.click(screen.getByLabelText("Default"));
		await user.click(screen.getByText("Save"));

		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "new.prompt",
			template: "Template body",
			version: 3,
			locale: "es",
			modelHint: "judge-kind",
			isSystem: true,
			isDefault: true,
		});
		expect(await screen.findByText("new.prompt")).toBeTruthy();
	});

	it("creates with only required fields — optionals stay off the wire", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<PromptsPage prompts={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add prompt"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "minimal.prompt");
		await user.type(inputs[3]!, "body");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			name: "minimal.prompt",
			template: "body",
			isSystem: false,
			isDefault: false,
		});
	});

	it("edits an existing version — prefilled draft, enabled toggle on the wire", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<PromptsPage
				prompts={[
					card({
						id: 7,
						name: "edit.me",
						version: 2,
						locale: "pt-BR",
						template: "old body",
						modelHint: "hint",
						isSystem: true,
						isDefault: true,
						enabled: true,
					}),
				]}
				api={api}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("Edit"));
		const inputs = screen.getAllByRole("textbox");
		// Edit mode hides name/version/locale — inputs are template + modelHint.
		expect((inputs[0] as HTMLTextAreaElement).value).toBe("old body");
		expect((inputs[1] as HTMLInputElement).value).toBe("hint");
		expect(screen.queryByDisplayValue("edit.me")).toBeNull();
		const enabledBox = screen.getByLabelText("Enabled") as HTMLInputElement;
		expect(enabledBox.checked).toBe(true);
		await user.click(enabledBox);
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.update).toHaveBeenCalled());
		expect(api.update.mock.calls[0]?.[0]).toMatchObject({
			id: 7,
			template: "old body",
			modelHint: "hint",
			isSystem: true,
			isDefault: true,
			enabled: false,
		});
	});

	it("update omits modelHint when the draft's is empty", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<PromptsPage
				prompts={[card({ id: 9, name: "sparse", modelHint: null })]}
				api={api}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("Edit"));
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.update).toHaveBeenCalled());
		const payload = api.update.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).not.toHaveProperty("modelHint");
		expect(payload.id).toBe(9);
	});

	it("new-version prefill goes through the create path", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<PromptsPage
				prompts={[card({ id: 3, name: "fam.prompt", locale: "pt-BR", isSystem: true })]}
				api={api}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New version"));
		const inputs = screen.getAllByRole("textbox");
		expect((inputs[0] as HTMLInputElement).value).toBe("fam.prompt");
		expect((inputs[2] as HTMLInputElement).value).toBe("pt-BR");
		expect((screen.getByLabelText("System prompt") as HTMLInputElement).checked).toBe(true);
		await user.type(inputs[3]!, "v2 body");
		await user.click(screen.getByText("Save"));
		await waitFor(() => expect(api.create).toHaveBeenCalled());
		expect(api.create.mock.calls[0]?.[0]).toMatchObject({
			name: "fam.prompt",
			locale: "pt-BR",
			template: "v2 body",
			isSystem: true,
		});
	});

	it("shows the error line when a mutation fails or payload is missing", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.create.mockResolvedValueOnce({ ok: false });
		render(<PromptsPage prompts={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add prompt"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[0]!, "x");
		await user.type(inputs[3]!, "t");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();

		api.create.mockResolvedValueOnce({ ok: true });
		await user.click(screen.getByText("Add prompt"));
		const inputs2 = screen.getAllByRole("textbox");
		await user.type(inputs2[0]!, "y");
		await user.type(inputs2[3]!, "t2");
		await user.click(screen.getByText("Save"));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("deletes a prompt after the confirm step; cancel keeps it", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<PromptsPage prompts={[card({ id: 5, name: "doomed" })]} api={api} locale="en" />);

		await user.click(screen.getByText("Delete"));
		await user.click(screen.getByText("Cancel"));
		expect(api.remove).not.toHaveBeenCalled();
		expect(screen.getByText("doomed")).toBeTruthy();

		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		await waitFor(() => expect(api.remove).toHaveBeenCalledWith(5));
		await waitFor(() => expect(screen.queryByText("doomed")).toBeNull());
	});

	it("surfaces remove failures", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		api.remove.mockResolvedValueOnce({ ok: false });
		render(<PromptsPage prompts={[card({ id: 6, name: "stuck" })]} api={api} locale="en" />);
		await user.click(screen.getByText("Delete"));
		await user.click(document.querySelector("[data-slot=confirm-dialog-action]") as HTMLElement);
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
		expect(screen.getByText("stuck")).toBeTruthy();
	});

	it("sorts merged versions by name then version desc", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(
			<PromptsPage prompts={[card({ id: 1, name: "fam", version: 1 })]} api={api} locale="en" />,
		);
		// New version of the same family lands above v1 (version desc).
		await user.click(screen.getByText("New version"));
		const inputs = screen.getAllByRole("textbox");
		await user.type(inputs[3]!, "v2");
		api.create.mockResolvedValueOnce({
			ok: true as const,
			data: card({ id: 2, name: "fam", version: 2, template: "v2" }),
		});
		await user.click(screen.getByText("Save"));
		await screen.findByText("v2");
		const versions = screen
			.getAllByRole("row")
			.slice(1)
			.map((r) => r.textContent ?? "")
			.filter((t) => t.includes("fam"));
		expect(versions[0]).toContain("v2");
		expect(versions[1]).toContain("v1");
	});

	it("closes the editor via Cancel and via Escape", async () => {
		const user = userEvent.setup();
		const api = makeApi();
		render(<PromptsPage prompts={[]} api={api} locale="en" />);
		await user.click(screen.getByText("Add prompt"));
		await user.click(screen.getByText("Cancel"));
		expect(screen.queryByPlaceholderText("anamnesis.extract")).toBeNull();

		await user.click(screen.getByText("Add prompt"));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByPlaceholderText("anamnesis.extract")).toBeNull());
	});
});
