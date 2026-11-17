// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Plugin } from "@ktb/kernel";
import { definePlugin } from "@ktb/kernel";

import type { FormDefinition } from "./definition.ts";
import { formDefContribution } from "./definition.ts";
import { FormsPage } from "./forms-page.tsx";
import type { PageContext } from "@ktb/kernel";

const intake: FormDefinition = {
	id: "intake",
	title: "Patient intake",
	schema: {
		type: "object",
		properties: { name: { type: "string" } },
	},
};

const ctxWith = (plugins: readonly Plugin[], locale = "en"): PageContext => ({
	plugins,
	locale,
});

const contributor = definePlugin({
	id: "clinic.intake",
	contributions: [formDefContribution(intake)],
});

afterEach(cleanup);

describe("FormsPage", () => {
	it("renders the contributed form and shows the preview notice on submit", () => {
		render(<FormsPage data="/forms/intake" ctx={ctxWith([contributor])} />);
		expect(screen.getByRole("heading", { name: "Patient intake" })).toBeDefined();
		expect(screen.getByLabelText("name")).toBeDefined();
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ana" } });
		fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		expect(screen.getByRole("status").textContent).toContain("preview");
	});

	it("falls back to the form id when title is absent", () => {
		const untitled = definePlugin({
			id: "clinic.other",
			contributions: [formDefContribution({ id: "other", schema: { type: "object" } })],
		});
		render(<FormsPage data="/forms/other" ctx={ctxWith([untitled])} />);
		expect(screen.getByRole("heading", { name: "other" })).toBeDefined();
	});

	it("renders the localized not-found state for unknown ids", () => {
		render(<FormsPage data="/forms/missing" ctx={ctxWith([contributor], "pt-BR")} />);
		expect(screen.getByText("Formulário não encontrado")).toBeDefined();
	});

	it("renders not-found for non-string loader data", () => {
		render(<FormsPage data={null} ctx={ctxWith([contributor])} />);
		expect(screen.getByText("Form not found")).toBeDefined();
	});
});
