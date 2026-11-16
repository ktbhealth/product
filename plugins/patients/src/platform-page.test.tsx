// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, params, ...props }: Record<string, unknown>) =>
			React.createElement(
				"a",
				{
					...props,
					href: String(to).replace("$id", String((params as { id?: string })?.id ?? "")),
				},
				props.children as never,
			),
		useRouter: () => ({ invalidate: vi.fn() }),
	};
});

vi.mock("./fns.ts", () => ({
	adminCreatePatientFn: vi.fn(),
	createPatientFn: vi.fn(),
	deletePatientFn: vi.fn(),
	patientDeletionImpactFn: vi.fn(),
	updatePatientFn: vi.fn(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { AdminPatientRow, OwnerOption } from "./index.ts";
import { makePatient } from "./testing.ts";
import { PatientsPlatformPage } from "./platform-page.tsx";

afterEach(cleanup);

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Partial<AdminPatientRow> = {}): AdminPatientRow => ({
	...makePatient({ name: "Ana" }),
	ownerEmail: "dra@x.com",
	ownerName: "Dra Ana",
	...over,
});

describe("PatientsPlatformPage", () => {
	it("renders the empty state when the loader returns no rows", () => {
		render(<PatientsPlatformPage data={{ patients: [], owners: [] }} ctx={ctx} />);
		expect(screen.getByText("No patients")).toBeTruthy();
	});

	it("narrows the loader data into the admin listing rows", () => {
		const owners: OwnerOption[] = [{ id: "u1", label: "Dra Ana" }];
		render(<PatientsPlatformPage data={{ patients: [row()], owners }} ctx={ctx} />);
		expect(screen.getByText("1 patient across all owners.")).toBeTruthy();
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Dra Ana")).toBeTruthy();
	});
});
