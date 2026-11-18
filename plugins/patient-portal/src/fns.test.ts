import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	ensureSessionUser: vi.fn(),
	getPatientContext: vi.fn(),
	getSessionUser: vi.fn(),
	runAs: vi.fn(),
	setPatientSelection: vi.fn(),
}));

// Same fake as the host's route tests: the handler runs as a plain async fn.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));
vi.mock("@ktb/server-fns", () => mocks);

import { Forbidden } from "@ktb/authz";
import { Audit } from "@ktb/audit";

import { PatientPortal } from "./index.ts";
import {
	patientActivityFacetsFn,
	patientActivityFn,
	patientActivityQueryFn,
	portalDekEnvelopesFn,
	portalRegisterDeviceFn,
	portalSessionFn,
	selectPatientFn,
} from "./fns.ts";

const user = { id: "ana", email: "ana@ktb.test", name: "Ana" };
const me = { patientId: 1, name: "Ana", relation: "self" };
const kid = { patientId: 2, name: "Leo", relation: "guardian" };
const portal = {
	registerDevice: vi.fn(),
	dekEnvelopes: vi.fn(),
};
const audit = {
	patientList: vi.fn(),
	patientFacets: vi.fn(),
};
const denied = Effect.fail(new Forbidden({ path: "portal.read" }));
const ACTIVITY_EMPTY = { entries: [], total: 0, limit: 100, offset: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	// runAs executes the program against the PatientPortal + Audit stubs.
	mocks.runAs.mockImplementation(
		(_user: unknown, effect: Effect.Effect<unknown, unknown, PatientPortal | Audit>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provideService(PatientPortal, portal as never),
					Effect.provideService(Audit, audit as never),
				),
			),
	);
});

describe("portalSessionFn", () => {
	it("reports whether a session exists", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		await expect(portalSessionFn()).resolves.toEqual({ signedIn: true });
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(portalSessionFn()).resolves.toEqual({ signedIn: false });
	});
});

describe("selectPatientFn", () => {
	it("stores a profile the user holds", async () => {
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me, kid], active: me });
		await expect(selectPatientFn({ data: 2 })).resolves.toEqual({ ok: true });
		expect(mocks.setPatientSelection).toHaveBeenCalledWith(2);
	});

	it("refuses a profile the user does not hold, and anonymous callers", async () => {
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		await expect(selectPatientFn({ data: 2 })).resolves.toEqual({ ok: false });
		mocks.getPatientContext.mockResolvedValue(null);
		await expect(selectPatientFn({ data: 1 })).resolves.toEqual({ ok: false });
		expect(mocks.setPatientSelection).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric id on the wire", async () => {
		await expect(selectPatientFn({ data: "x" as never })).rejects.toThrow();
	});
});

describe("portalRegisterDeviceFn", () => {
	const device = { wrapPublicKey: "wrap", signPublicKey: "sign" };

	beforeEach(() => {
		mocks.ensureSessionUser.mockResolvedValue(user);
		portal.registerDevice.mockReturnValue(Effect.succeed({ id: 4, userId: "ana" }));
	});

	it("registers the session user's device pubkeys", async () => {
		await expect(portalRegisterDeviceFn({ data: device })).resolves.toEqual({
			ok: true,
			device: { id: 4, userId: "ana" },
		});
		expect(mocks.runAs).toHaveBeenCalledWith(user, expect.anything());
		expect(portal.registerDevice).toHaveBeenCalledWith(device);
	});

	it("reports a denied registration without throwing", async () => {
		portal.registerDevice.mockReturnValue(denied);
		await expect(portalRegisterDeviceFn({ data: device })).resolves.toEqual({ ok: false });
	});

	it("validates the wire shape", async () => {
		await expect(portalRegisterDeviceFn({ data: { wrapPublicKey: "" } })).rejects.toThrow();
	});
});

describe("portalDekEnvelopesFn", () => {
	const input = {
		entityType: "consultation" as const,
		entityIds: [10, "12"],
		wrapPublicKey: "dev",
	};

	it("is empty for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(portalDekEnvelopesFn({ data: input })).resolves.toEqual({});
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns the caller's envelopes keyed by record", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		portal.dekEnvelopes.mockReturnValue(Effect.succeed({ "10": "w1.x" }));
		await expect(portalDekEnvelopesFn({ data: input })).resolves.toEqual({ "10": "w1.x" });
		expect(mocks.runAs).toHaveBeenCalledWith(user, expect.anything());
		expect(portal.dekEnvelopes).toHaveBeenCalledWith(input);
	});

	it("is empty — not an error — when the read is denied", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		portal.dekEnvelopes.mockReturnValue(denied);
		await expect(portalDekEnvelopesFn({ data: input })).resolves.toEqual({});
	});

	it("validates the wire shape", async () => {
		await expect(
			portalDekEnvelopesFn({ data: { entityType: "bogus", entityIds: [], wrapPublicKey: "d" } }),
		).rejects.toThrow();
	});
});

describe("patientActivityFn", () => {
	const feed = { entries: [{ id: 1, action: "patients.update" }], total: 1, limit: 100 };

	it("is an empty page for anonymous visitors", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(patientActivityFn({ data: { patientId: 1 } })).resolves.toEqual(ACTIVITY_EMPTY);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns the patient-scoped feed as the session user", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		audit.patientList.mockReturnValue(Effect.succeed(feed));
		await expect(patientActivityFn({ data: { patientId: 1 } })).resolves.toEqual(feed);
		expect(mocks.runAs).toHaveBeenCalledWith(user, expect.anything());
		expect(audit.patientList).toHaveBeenCalledWith({ patientId: 1, limit: 100 });
	});

	it("is an empty page — not an error — when the read is denied", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		audit.patientList.mockReturnValue(Effect.fail(new Forbidden({ path: "audit.patient" })));
		await expect(patientActivityFn({ data: { patientId: 9 } })).resolves.toEqual(ACTIVITY_EMPTY);
	});

	it("is an empty page when the audit plugin is absent", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		// runAs without the Audit service — serviceOption resolves None.
		mocks.runAs.mockImplementationOnce(
			(_user: unknown, effect: Effect.Effect<unknown, unknown, PatientPortal>) =>
				Effect.runPromise(effect.pipe(Effect.provideService(PatientPortal, portal as never))),
		);
		await expect(patientActivityFn({ data: { patientId: 1 } })).resolves.toEqual(ACTIVITY_EMPTY);
		expect(audit.patientList).not.toHaveBeenCalled();
	});

	it("rejects a malformed patientId on the wire", async () => {
		await expect(patientActivityFn({ data: { patientId: "x" } })).rejects.toThrow();
	});
});

describe("patientActivityQueryFn", () => {
	const feed = { entries: [{ id: 1 }], total: 9, limit: 50, offset: 50 };

	it("is an empty page for anonymous visitors and without an open record", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(patientActivityQueryFn({ data: { offset: 50 } })).resolves.toEqual(ACTIVITY_EMPTY);
		await expect(patientActivityQueryFn({ data: undefined })).resolves.toEqual(ACTIVITY_EMPTY);
		expect(mocks.runAs).not.toHaveBeenCalled();
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue(null);
		await expect(patientActivityQueryFn({ data: {} })).resolves.toEqual(ACTIVITY_EMPTY);
		expect(audit.patientList).not.toHaveBeenCalled();
	});

	it("queries the open record's feed with filters and pagination", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		audit.patientList.mockReturnValue(Effect.succeed(feed));
		const query = {
			limit: 50,
			offset: 50,
			q: "update",
			actionGroup: "patients",
			actor: null,
			targetType: "patient",
			since: 10,
			until: 20,
		};
		await expect(patientActivityQueryFn({ data: query })).resolves.toEqual(feed);
		expect(audit.patientList).toHaveBeenCalledWith({ patientId: 1, ...query });
	});

	it("is an empty page when the read is denied or the audit plugin is absent", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		audit.patientList.mockReturnValue(Effect.fail(new Forbidden({ path: "audit.patient" })));
		await expect(patientActivityQueryFn({ data: {} })).resolves.toEqual(ACTIVITY_EMPTY);
		mocks.runAs.mockImplementationOnce(
			(_user: unknown, effect: Effect.Effect<unknown, unknown, PatientPortal>) =>
				Effect.runPromise(effect.pipe(Effect.provideService(PatientPortal, portal as never))),
		);
		await expect(patientActivityQueryFn({ data: {} })).resolves.toEqual(ACTIVITY_EMPTY);
	});
});

describe("patientActivityFacetsFn", () => {
	const facets = { actionGroups: ["patients"], actors: ["staff@x.com"], targetTypes: ["patient"] };
	const EMPTY_FACETS = { actionGroups: [], actors: [], targetTypes: [] };

	it("is empty for anonymous callers and without an open record", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(patientActivityFacetsFn()).resolves.toEqual(EMPTY_FACETS);
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue(null);
		await expect(patientActivityFacetsFn()).resolves.toEqual(EMPTY_FACETS);
	});

	it("returns the open record's facets", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		audit.patientFacets.mockReturnValue(Effect.succeed(facets));
		await expect(patientActivityFacetsFn()).resolves.toEqual(facets);
		expect(audit.patientFacets).toHaveBeenCalledWith({ patientId: 1 });
	});

	it("is empty when denied or the audit plugin is absent", async () => {
		mocks.getSessionUser.mockResolvedValue(user);
		mocks.getPatientContext.mockResolvedValue({ user, profiles: [me], active: me });
		audit.patientFacets.mockReturnValue(Effect.fail(new Forbidden({ path: "audit.patient" })));
		await expect(patientActivityFacetsFn()).resolves.toEqual(EMPTY_FACETS);
		mocks.runAs.mockImplementationOnce(
			(_user: unknown, effect: Effect.Effect<unknown, unknown, PatientPortal>) =>
				Effect.runPromise(effect.pipe(Effect.provideService(PatientPortal, portal as never))),
		);
		await expect(patientActivityFacetsFn()).resolves.toEqual(EMPTY_FACETS);
	});
});
