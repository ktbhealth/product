import { describe, expect, it } from "vitest";

import type { DocumentRecord } from "@ktb/document-store";

import { toViewRecordWire } from "./wire.ts";

const record = (over: Partial<DocumentRecord> = {}): DocumentRecord =>
	({
		id: 7,
		collectionId: 3,
		collection: "c.d",
		data: { name: "x" },
		ownerId: "u1",
		tenantId: null,
		createdAt: new Date("2024-01-02T03:04:05.000Z"),
		updatedAt: new Date("2024-02-03T04:05:06.000Z"),
		...over,
	}) as DocumentRecord;

describe("toViewRecordWire", () => {
	it("serializes a record with ISO timestamps", () => {
		expect(toViewRecordWire(record())).toEqual({
			id: 7,
			collection: "c.d",
			data: { name: "x" },
			createdAt: "2024-01-02T03:04:05.000Z",
			updatedAt: "2024-02-03T04:05:06.000Z",
		});
	});
});
