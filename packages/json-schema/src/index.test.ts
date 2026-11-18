import { describe, expect, it } from "vitest";

import * as api from "./index.ts";

describe("@ktb/json-schema public API", () => {
	it("exports the documented surface", () => {
		expect(typeof api.checkSchema).toBe("function");
		expect(typeof api.assertSchema).toBe("function");
		expect(typeof api.compileSchema).toBe("function");
		expect(typeof api.validate).toBe("function");
		expect(api.SchemaDefinitionError).toBeDefined();
		expect(api.JSON_SCHEMA_TYPES).toHaveLength(7);
		expect(api.MAX_PATTERN_LENGTH).toBe(200);
	});
});
