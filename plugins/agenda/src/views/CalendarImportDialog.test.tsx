import { describe, expect, it } from "vitest";

import { buildImportFilter } from "./CalendarImportDialog.tsx";

const base = {
	dateFrom: "2026-11-01",
	dateTo: "2026-11-30",
	text: "",
	location: "",
	participant: "",
	eventTypes: [] as readonly string[],
	tagKey: "",
	tagValue: "",
};

describe("buildImportFilter", () => {
	it("composes just the window when every optional input is blank", () => {
		const filter = buildImportFilter(base);
		expect(filter).not.toBeNull();
		expect(filter?.op).toBe("and");
		if (filter?.op !== "and") return;
		expect(filter.args).toHaveLength(2);
		const [endsBound, startBound] = filter.args;
		expect(endsBound).toMatchObject({ op: "gt", field: "endsAt" });
		expect(startBound).toMatchObject({ op: "lt", field: "startsAt" });
		// Local-midnight boundaries; the end date is exclusive +1 day.
		if (endsBound?.op === "gt" && startBound?.op === "lt") {
			expect(new Date(String(endsBound.value)).getTime()).toBe(
				new Date("2026-11-01T00:00:00").getTime(),
			);
			expect(new Date(String(startBound.value)).getTime()).toBe(
				new Date("2026-12-01T00:00:00").getTime(),
			);
		}
	});

	it("adds text, location, participant, types and tag conditions", () => {
		const filter = buildImportFilter({
			...base,
			text: "consulta",
			location: "clínica",
			participant: "maria@",
			eventTypes: ["default", "outOfOffice"],
			tagKey: "workspace",
			tagValue: "ktb",
		});
		if (filter?.op !== "and") throw new Error("expected and node");
		expect(filter.args).toContainEqual({ op: "contains", field: "text", value: "consulta" });
		expect(filter.args).toContainEqual({ op: "contains", field: "location", value: "clínica" });
		expect(filter.args).toContainEqual({ op: "contains", field: "attendee", value: "maria@" });
		expect(filter.args).toContainEqual({
			op: "in",
			field: "eventType",
			values: ["default", "outOfOffice"],
		});
		expect(filter.args).toContainEqual({ op: "eq", field: "property.workspace", value: "ktb" });
	});

	it("drops blank optional inputs and half-filled tag pairs", () => {
		const filter = buildImportFilter({ ...base, tagKey: "workspace", tagValue: "" });
		if (filter?.op !== "and") throw new Error("expected and node");
		expect(filter.args).toHaveLength(2);
	});

	it("returns null without a valid date range", () => {
		expect(buildImportFilter({ ...base, dateFrom: "" })).toBeNull();
		expect(buildImportFilter({ ...base, dateTo: "" })).toBeNull();
	});
});
