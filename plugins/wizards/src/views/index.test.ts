import { describe, expect, it } from "vitest";

import { WizardRunner, WizardsAdminPage } from "./index.ts";

describe("views barrel", () => {
	it("re-exports the wizard view components", () => {
		expect(WizardRunner).toBeDefined();
		expect(WizardsAdminPage).toBeDefined();
	});
});
