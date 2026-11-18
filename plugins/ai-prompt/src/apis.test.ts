import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	promptsCreateFn: vi.fn(),
	promptsRemoveFn: vi.fn(),
	promptsUpdateFn: vi.fn(),
}));

vi.mock("./fns.ts", () => mocks);

import { promptsApi } from "./apis.ts";

describe("promptsApi", () => {
	it("binds the view surface to the plugin server fns", async () => {
		const input = {
			name: "anamnesis.extract",
			template: "Extract {transcript}",
			version: 2,
			locale: "pt-BR",
			variables: [{ name: "transcript", required: true }],
			modelHint: "kind:chat",
			isSystem: true,
			isDefault: false,
		};
		await promptsApi.create(input);
		expect(mocks.promptsCreateFn).toHaveBeenCalledWith({ data: input });

		await promptsApi.update({ id: 4, enabled: false, template: "t" });
		expect(mocks.promptsUpdateFn).toHaveBeenCalledWith({
			data: { id: 4, enabled: false, template: "t" },
		});

		await promptsApi.remove(9);
		expect(mocks.promptsRemoveFn).toHaveBeenCalledWith({ data: { id: 9 } });
	});
});
