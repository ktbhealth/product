// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
}));

import type { PageContext } from "@ktb/kernel";

import { VaultClinicPage } from "./vault-page.tsx";

const ctx = { plugins: [], locale: "en" } as unknown as PageContext;

afterEach(cleanup);

describe("VaultClinicPage", () => {
	it("narrows loader data into the settings view", () => {
		render(
			<VaultClinicPage data={{ tenantId: 7, role: "member", zk: false, devices: [] }} ctx={ctx} />,
		);
		expect(screen.getByText("Clinic vault")).toBeTruthy();
		expect(screen.getByText("Ask a clinic admin", { exact: false })).toBeTruthy();
	});

	it("tolerates absent data (personal scope fallback)", () => {
		render(<VaultClinicPage data={null} ctx={ctx} />);
		expect(screen.getByText("Select a clinic workspace", { exact: false })).toBeTruthy();
	});
});
