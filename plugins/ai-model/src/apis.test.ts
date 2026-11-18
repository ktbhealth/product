import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	modelsCreateFn: vi.fn(),
	modelsRemoveFn: vi.fn(),
	modelsUpdateFn: vi.fn(),
}));

vi.mock("./fns.ts", () => mocks);

import { modelsApi } from "./apis.ts";

describe("modelsApi", () => {
	it("binds the view surface to the plugin server fns", async () => {
		const input = {
			name: "local-qwen",
			modelId: "qwen2.5:7b-instruct",
			endpointId: 3,
			kind: "chat",
			capabilities: ["chat", "eval-judge"],
			contextTokens: 32_768,
			costTier: "free",
			isDefault: true,
		};
		await modelsApi.create(input);
		expect(mocks.modelsCreateFn).toHaveBeenCalledWith({ data: input });

		await modelsApi.update({ id: 4, enabled: false, costTier: "high" });
		expect(mocks.modelsUpdateFn).toHaveBeenCalledWith({
			data: { id: 4, enabled: false, costTier: "high" },
		});

		await modelsApi.remove(9);
		expect(mocks.modelsRemoveFn).toHaveBeenCalledWith({ data: { id: 9 } });
	});
});
