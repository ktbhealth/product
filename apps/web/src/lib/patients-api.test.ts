import { describe, expect, it, vi } from "vitest";

import { reactStartMock, reactStartServerMock } from "@ktb/server-fns/testing";

vi.mock("cloudflare:workers", () => ({
	env: {
		DB: {},
		AI: { run: vi.fn() },
		BETTER_AUTH_SECRET: "x".repeat(32),
		BETTER_AUTH_URL: "http://localhost:3000",
	},
}));
vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

// platform.ts publishes the server runtime (@ktb/server-fns) that the
// patients plugin's fns reach through the registry (P-033).
import "./platform.ts";
import { editPatientApi, newPatientApi, patientDeleteApi } from "@ktb/patients/apis";

describe("patient form api wiring", () => {
	it("delegates create and update to the server fns", async () => {
		// anonymous: write fns throw — the arrows still execute end to end
		await expect(newPatientApi.save({ name: "Ana", birthDate: "1984" })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(editPatientApi(3).save({ name: "Ana", birthDate: "1984" })).rejects.toThrow(
			"unauthenticated",
		);
	});

	it("delegates deletion impact and the cascade to the server fns", async () => {
		// anonymous: impact is null, delete throws — both arrows execute end to end
		await expect(patientDeleteApi.impact(3)).resolves.toBeNull();
		await expect(patientDeleteApi.remove(3)).rejects.toThrow("unauthenticated");
	});
});
