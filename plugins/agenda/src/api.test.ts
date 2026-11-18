import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
	AppointmentCancelled,
	AppointmentReminderDue,
	AppointmentScheduled,
	AppointmentUpdated,
} from "./api.ts";

describe("agenda events", () => {
	it("carries the scheduled appointment identity", () => {
		const e = AppointmentScheduled.make({
			id: 1,
			ownerId: "u1",
			patientId: 7,
			startsAt: new Date(0),
		});
		expect(e._tag).toBe("appointment.scheduled");
		expect(e.tenantId).toBeUndefined();
	});

	it("accepts a tenant id on every event", () => {
		const at = new Date(0);
		expect(
			AppointmentUpdated.make({ id: 1, ownerId: "u1", startsAt: at, tenantId: 7 }).tenantId,
		).toBe(7);
		expect(AppointmentCancelled.make({ id: 1, ownerId: "u1", tenantId: null }).tenantId).toBeNull();
	});

	it("encodes the reminder payload with a nullable patient name", () => {
		const e = AppointmentReminderDue.make({
			id: 2,
			ownerId: "u1",
			patientName: null,
			startsAt: new Date(0),
			tenantId: 8,
		});
		expect(e._tag).toBe("appointment.reminderDue");
		expect(e.patientName).toBeNull();
		// The event schema rejects a non-nullable patientName wire value.
		const decode = Schema.decodeUnknownSync(AppointmentReminderDue.schema);
		expect(() =>
			decode({
				_tag: "appointment.reminderDue",
				id: 2,
				ownerId: "u1",
				startsAt: new Date(0),
			}),
		).toThrow(/./);
	});
});
