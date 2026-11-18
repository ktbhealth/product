import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	machinesBeatFn: vi.fn(),
	machinesCheckAllFn: vi.fn(),
	machinesCheckFn: vi.fn(),
	machinesCreateFn: vi.fn(),
	machinesRemoveFn: vi.fn(),
	machinesUpdateFn: vi.fn(),
}));

vi.mock("./fns.ts", () => mocks);

import { machinesApi } from "./apis.ts";

describe("machinesApi", () => {
	it("binds the view surface to the plugin server fns", async () => {
		const input = {
			name: "gpu-1",
			kind: "gpu",
			host: "10.0.0.5",
			port: 22,
			capabilities: ["acp"],
			secretRef: "vault:3",
			healthUrl: "http://h/health",
		};
		await machinesApi.create(input);
		expect(mocks.machinesCreateFn).toHaveBeenCalledWith({ data: input });

		await machinesApi.update({ id: 4, enabled: false });
		expect(mocks.machinesUpdateFn).toHaveBeenCalledWith({ data: { id: 4, enabled: false } });

		await machinesApi.remove(9);
		expect(mocks.machinesRemoveFn).toHaveBeenCalledWith({ data: { id: 9 } });

		await machinesApi.check(9);
		expect(mocks.machinesCheckFn).toHaveBeenCalledWith({ data: { id: 9 } });

		await machinesApi.checkAll();
		expect(mocks.machinesCheckAllFn).toHaveBeenCalledWith();

		await machinesApi.beat(9);
		expect(mocks.machinesBeatFn).toHaveBeenCalledWith({ data: { id: 9 } });
	});
});
