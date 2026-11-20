import { describe, expect, it } from "vitest";

import { resolveTemplate } from "./template.ts";

describe("resolveTemplate", () => {
	const scope: Record<string, unknown> = {
		record: { id: 3, data: { name: "n" } },
		event: { by: "u1", n: 4 },
		flow: { id: "doc-review" },
	};

	it("resolves $<scope>.<path> templates", () => {
		expect(resolveTemplate("$record.id", scope)).toBe(3);
		expect(resolveTemplate("$record.data.name", scope)).toBe("n");
		expect(resolveTemplate("$event.n", scope)).toBe(4);
		expect(resolveTemplate("$flow.id", scope)).toBe("doc-review");
	});

	it("passes non-strings and non-templates through literally", () => {
		expect(resolveTemplate(42, scope)).toBe(42);
		expect(resolveTemplate(null, scope)).toBeNull();
		expect(resolveTemplate({ a: 1 }, scope)).toEqual({ a: 1 });
		expect(resolveTemplate("plain", scope)).toBe("plain");
		expect(resolveTemplate("$event", scope)).toBe("$event"); // no dot path
		expect(resolveTemplate("costs $5", scope)).toBe("costs $5");
		expect(resolveTemplate("costs $record.id", scope)).toBe("costs $record.id");
		expect(resolveTemplate("$record.id\nextra", scope)).toBe("$record.id\nextra");
	});

	it("passes unresolved templates through literally", () => {
		expect(resolveTemplate("$event.missing", scope)).toBe("$event.missing");
		expect(resolveTemplate("$bogus.path", scope)).toBe("$bogus.path");
		expect(resolveTemplate("$record.data.absent.deep", scope)).toBe("$record.data.absent.deep");
	});

	it("never resolves roots through the prototype chain", () => {
		expect(resolveTemplate("$constructor.name", scope)).toBe("$constructor.name");
		expect(resolveTemplate("$record.__proto__.x", scope)).toBe("$record.__proto__.x");
	});
});
