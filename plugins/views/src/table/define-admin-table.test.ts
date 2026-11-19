import { describe, expect, it } from "vitest";

import { defineAdminTable, type AdminTableDef } from "./define-admin-table.ts";

interface Row {
	id: number;
	name: string;
}

interface Msgs {
	title: string;
}

const base = (): AdminTableDef<Row, Msgs> => ({
	id: "test.table",
	i18n: { namespace: "test", messages: () => ({ title: "Rows" }) },
	title: (t) => t.title,
	columns: [{ key: "name", header: "Name" }],
});

describe("defineAdminTable", () => {
	it("returns the definition unchanged when valid", () => {
		const def = base();
		expect(defineAdminTable(def)).toBe(def);
	});

	it("accepts defs with actions and create", () => {
		const def: AdminTableDef<Row, Msgs> = {
			...base(),
			rowActions: [
				{ id: "suspend", label: "Suspend", run: async () => ({ ok: true }) },
				{
					id: "delete",
					label: "Delete",
					confirm: { title: "Delete?" },
					run: async () => true,
				},
			],
			bulkActions: [{ id: "bulk", label: "Bulk", run: async () => ({ ok: true }) }],
			create: {
				label: "New",
				fields: [{ name: "name", label: "Name" }],
				onSubmit: async () => true,
			},
		};
		expect(defineAdminTable(def)).toBe(def);
	});

	it("rejects an empty or blank id", () => {
		expect(() => defineAdminTable({ ...base(), id: "" })).toThrow(/id must be a non-empty/);
		expect(() => defineAdminTable({ ...base(), id: "   " })).toThrow(/id must be a non-empty/);
	});

	it("rejects empty columns", () => {
		expect(() => defineAdminTable({ ...base(), columns: [] })).toThrow(/columns must be non-empty/);
	});

	it("rejects duplicate column keys", () => {
		const def: AdminTableDef<Row, Msgs> = {
			...base(),
			columns: [
				{ key: "name", header: "Name" },
				{ key: "name", header: "Name 2" },
			],
		};
		expect(() => defineAdminTable(def)).toThrow(/duplicate column key "name"/);
	});

	it("rejects duplicate row action ids", () => {
		const def: AdminTableDef<Row, Msgs> = {
			...base(),
			rowActions: [
				{ id: "act", label: "A", run: async () => true },
				{ id: "act", label: "B", run: async () => true },
			],
		};
		expect(() => defineAdminTable(def)).toThrow(/duplicate row action "act"/);
	});

	it("rejects duplicate bulk action ids", () => {
		const def: AdminTableDef<Row, Msgs> = {
			...base(),
			bulkActions: [
				{ id: "b", label: "B1", run: async () => true },
				{ id: "b", label: "B2", run: async () => true },
			],
		};
		expect(() => defineAdminTable(def)).toThrow(/duplicate bulk action "b"/);
	});
});
