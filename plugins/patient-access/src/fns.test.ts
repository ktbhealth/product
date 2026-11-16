import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
	getDoctorAccess: vi.fn(),
	getDoctorContext: vi.fn(),
	getDoctorUser: vi.fn(),
	getLocale: vi.fn(() => "en"),
	run: vi.fn(),
	runAs: vi.fn(),
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
vi.mock("@tanstack/react-start/server", () => ({
	getRequestUrl: () => new URL("https://app.ktb.test/consultations/new"),
}));
vi.mock("@ktb/server-fns", () => mocks);

import { Forbidden } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Email, type EmailSender } from "@ktb/email";
import { Invites } from "@ktb/invites";

import { PatientInviteRejected, PatientLinks } from "./index.ts";
import {
	approvePatientLinkFn,
	clinicalPortalFn,
	doctorAccessFn,
	invitePatientFn,
	patientLinksFn,
	portalReadersFn,
	revokePatientLinkFn,
} from "./fns.ts";

const DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (id, name, slug, kind, zk) VALUES (8, 'ZK Clinic', 'clinic-8', 'clinic', 1);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, tenant_id INTEGER);
INSERT INTO patients (id, owner_id, name, email) VALUES
  (1, 'doc', 'Ana', 'ana@ktb.test'), (2, 'doc', 'Leo', NULL), (3, 'other', 'Rui', 'rui@ktb.test');
CREATE TABLE patient_access (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, user_id TEXT, email TEXT, relation TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, granted_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO patient_access (patient_id, user_id, relation, status, source, created_at, updated_at) VALUES
  (1, 'ana', 'self', 'active', 'invite', 0, 0),
  (1, 'eva', 'guardian', 'invited', 'invite', 0, 0);
INSERT INTO patient_access (patient_id, user_id, email, relation, status, source, created_at, updated_at) VALUES
  (1, NULL, 'nobody@ktb.test', 'self', 'invited', 'invite', 0, 0),
  (2, NULL, 'leo@ktb.test', 'self', 'invited', 'invite', 0, 0);
CREATE TABLE portal_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, wrap_public_key TEXT NOT NULL, sign_public_key TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO portal_keys (user_id, wrap_public_key, sign_public_key) VALUES
  ('ana', 'anaDev1', 's1'), ('ana', 'anaDev2', 's2');
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, transcript TEXT NOT NULL, anamnesis TEXT);
INSERT INTO consultations (id, patient_id, transcript, anamnesis) VALUES
  (10, 1, 'v1.ct', NULL), (11, 1, 'plain', '{}'), (12, 1, 'plain', 'v1.ct');
-- ZK tenant (group 8) and an unresolvable tenantId (999, fail-closed):
-- both store ciphertext names the server cannot read (T-149).
INSERT INTO patients (id, owner_id, name, email, tenant_id) VALUES
  (4, 'doc', 'v1.aXYz.cipheredAna', 'zk@ktb.test', 8),
  (5, 'doc', 'v1.bYZa.cipheredGhost', 'ghost@ktb.test', 999);
`;
const db = makeDb(makeD1(DDL));

// A secretary acting for the doctor: data scope is the doctor's, the
// email is issued under the doctor's name.
const acting = {
	id: "doc",
	email: "sec@ktb.test",
	name: "Sec",
	actorId: "sec",
	doctor: { name: "Dra. Bia", email: "bia@ktb.test" },
};

const links = {
	list: vi.fn(),
	invite: vi.fn(),
	approve: vi.fn(),
	revoke: vi.fn(),
};
const denied = Effect.fail(new Forbidden({ path: "patient-access.read" }));

const sent: Array<{ to: string; subject: string; text: string }> = [];
/** The deployment's Email service: a sender, or null when email is off. */
let sender: EmailSender | null = null;
/** The invites plugin's `issue`, or null when it is not deployed. */
let issue: ReturnType<typeof vi.fn> | null = null;
const delivering: EmailSender = {
	send: async (message) => {
		sent.push(message);
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	sent.length = 0;
	sender = delivering;
	issue = null;
	mocks.getLocale.mockReturnValue("en");
	mocks.getDoctorUser.mockResolvedValue(acting);
	const provide = (effect: Effect.Effect<unknown, unknown, unknown>) => {
		const base = (effect as Effect.Effect<unknown, unknown, PatientLinks | Db | Email>).pipe(
			Effect.provideService(PatientLinks, links as never),
			Effect.provideService(Db, db),
			Effect.provideService(Email, sender),
		);
		return Effect.runPromise(
			issue === null
				? base
				: base.pipe(
						Effect.provideService(Invites, {
							issue: issue as never,
							preview: vi.fn(),
							accept: vi.fn(),
						}),
					),
		);
	};
	mocks.runAs.mockImplementation((_user: unknown, effect: never) => provide(effect));
	mocks.run.mockImplementation((effect: never) => provide(effect));
	links.list.mockReturnValue(Effect.succeed([{ id: 7, email: "ana@ktb.test", status: "active" }]));
	links.invite.mockReturnValue(Effect.succeed({ id: 9, email: "ana@ktb.test", status: "invited" }));
	links.approve.mockReturnValue(Effect.succeed(true));
	links.revoke.mockReturnValue(Effect.succeed(true));
});

describe("doctorAccessFn", () => {
	it("exposes the request's doctor-side standing", async () => {
		mocks.getDoctorAccess.mockResolvedValue("no-doctor");
		await expect(doctorAccessFn()).resolves.toBe("no-doctor");
	});
});

describe("clinicalPortalFn", () => {
	it("names the doctor instance for an account with an own profile", async () => {
		mocks.getDoctorContext.mockResolvedValue({
			profiles: [{ role: "owner" }, { role: "secretary" }],
		});
		await expect(clinicalPortalFn()).resolves.toBe("doctor");
	});

	it("names the secretary instance for a delegated-only account", async () => {
		mocks.getDoctorContext.mockResolvedValue({ profiles: [{ role: "secretary" }] });
		await expect(clinicalPortalFn()).resolves.toBe("secretary");
	});

	it("is null without a doctor context", async () => {
		mocks.getDoctorContext.mockResolvedValue(null);
		await expect(clinicalPortalFn()).resolves.toBeNull();
	});
});

describe("patientLinksFn", () => {
	it("returns the patient — with the record's email — and its links", async () => {
		await expect(patientLinksFn({ data: 1 })).resolves.toEqual({
			patient: { id: 1, name: "Ana", email: "ana@ktb.test" },
			links: [{ id: 7, email: "ana@ktb.test", status: "active" }],
		});
		expect(mocks.runAs).toHaveBeenCalledWith(acting, expect.anything());
		expect(links.list).toHaveBeenCalledWith(1);
	});

	it("carries a null email when the record has none", async () => {
		await expect(patientLinksFn({ data: 2 })).resolves.toMatchObject({
			patient: { id: 2, name: "Leo", email: null },
		});
	});

	it("is null for someone else's patient and for non-doctors", async () => {
		links.list.mockReturnValue(denied);
		await expect(patientLinksFn({ data: 3 })).resolves.toBeNull();
		mocks.getDoctorUser.mockResolvedValue(null);
		await expect(patientLinksFn({ data: 1 })).resolves.toBeNull();
	});

	it("is null when the record is gone by the time it is read", async () => {
		// The service's ownership check passed on a mocked list; the
		// patients row itself no longer exists (deleted mid-request).
		await expect(patientLinksFn({ data: 99 })).resolves.toBeNull();
	});
});

describe("invitePatientFn", () => {
	const invite = { patientId: 1, email: "ana@ktb.test", relation: "self" };

	it("creates the link and emails the invitee under the doctor's name", async () => {
		await expect(invitePatientFn({ data: invite })).resolves.toEqual({
			ok: true,
			link: { id: 9, email: "ana@ktb.test", status: "invited" },
			emailed: true,
		});
		expect(links.invite).toHaveBeenCalledWith(invite);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: "ana@ktb.test" });
		expect(sent[0]!.subject).toContain("Dra. Bia");
		expect(sent[0]!.text).toContain("Ana's consultations");
		expect(sent[0]!.text).toContain("https://app.ktb.test/login/patient");
	});

	it("sends someone with no account a single-use accept link", async () => {
		issue = vi.fn(() => Effect.succeed("tok-123"));
		await invitePatientFn({ data: invite });
		expect(issue).toHaveBeenCalledWith({
			email: "ana@ktb.test",
			kind: "patient",
			inviterName: "Dra. Bia",
		});
		expect(sent[0]!.text.split("\n")).toContain("https://app.ktb.test/invite#tok-123");
		expect(sent[0]!.text).toContain("choose your password");
		expect(sent[0]!.text).not.toContain("/login/patient");
	});

	it("points an address that already has an account at the portal sign-in", async () => {
		issue = vi.fn(() => Effect.succeed(null));
		await invitePatientFn({ data: invite });
		expect(sent[0]!.text.split("\n")).toContain("https://app.ktb.test/login/patient");
		expect(sent[0]!.text).toContain("Sign in with this email address");
	});

	it("issues no accept link when no email can go out", async () => {
		issue = vi.fn(() => Effect.succeed("tok-123"));
		sender = null;
		await expect(invitePatientFn({ data: invite })).resolves.toMatchObject({
			emailed: false,
		});
		expect(issue).not.toHaveBeenCalled();
	});

	it("writes the email in the acting user's locale", async () => {
		mocks.getLocale.mockReturnValue("pt-BR");
		await invitePatientFn({ data: invite });
		expect(sent[0]!.text).toContain("às consultas de Ana");
	});

	it("signs with the doctor's email when the profile has no name", async () => {
		mocks.getDoctorUser.mockResolvedValue({
			...acting,
			doctor: { name: null, email: "bia@ktb.test" },
		});
		await invitePatientFn({ data: invite });
		expect(sent[0]!.subject).toContain("bia@ktb.test");
	});

	it("sends metadata-only copy for a ZK tenant's patient (T-149)", async () => {
		await expect(
			invitePatientFn({ data: { patientId: 4, email: "zk@ktb.test", relation: "self" } }),
		).resolves.toMatchObject({ ok: true, emailed: true });
		expect(sent).toHaveLength(1);
		// The stored name is ciphertext — it must never reach the wire.
		expect(sent[0]!.text).not.toContain("v1.aXYz.cipheredAna");
		expect(sent[0]!.text).toContain("a patient record");
		expect(sent[0]!.subject).toContain("Dra. Bia");
	});

	it("fails closed to metadata-only copy for an unresolvable tenant", async () => {
		await invitePatientFn({ data: { patientId: 5, email: "ghost@ktb.test", relation: "self" } });
		expect(sent[0]!.text).not.toContain("v1.bYZa.cipheredGhost");
		expect(sent[0]!.text).toContain("a patient record");
	});

	it("still grants access, but says so, when this deployment sends no email", async () => {
		sender = null;
		await expect(invitePatientFn({ data: invite })).resolves.toMatchObject({
			ok: true,
			emailed: false,
		});
	});

	it("still grants access, but says so, when the delivery fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		sender = {
			send: async () => {
				throw new Error("smtp down");
			},
		};
		await expect(invitePatientFn({ data: invite })).resolves.toMatchObject({
			ok: true,
			emailed: false,
		});
		expect(logged).toHaveBeenCalledWith("patient invite email failed", expect.any(Error));
		logged.mockRestore();
	});

	it("grants access without an email when the record is gone mid-invite", async () => {
		await expect(
			invitePatientFn({
				data: { patientId: 99, email: "x@ktb.test", relation: "self" },
			}),
		).resolves.toEqual({
			ok: true,
			link: { id: 9, email: "ana@ktb.test", status: "invited" },
			emailed: false,
		});
		expect(sent).toHaveLength(0);
	});

	it("falls back to an empty address for a link that carries none", async () => {
		links.invite.mockReturnValue(Effect.succeed({ id: 9, email: null, status: "active" }));
		await expect(invitePatientFn({ data: invite })).resolves.toMatchObject({
			link: { id: 9, email: "", status: "active" },
		});
	});

	it("reports a refused invite without sending anything", async () => {
		links.invite.mockReturnValue(Effect.fail(new PatientInviteRejected({ code: "invalid_email" })));
		await expect(invitePatientFn({ data: invite })).resolves.toEqual({
			ok: false,
			error: "invalid_email",
		});
		links.invite.mockReturnValue(denied);
		await expect(invitePatientFn({ data: invite })).resolves.toEqual({
			ok: false,
			error: "failed",
		});
		mocks.getDoctorUser.mockResolvedValue(null);
		await expect(invitePatientFn({ data: invite })).resolves.toEqual({
			ok: false,
			error: "failed",
		});
		expect(sent).toHaveLength(0);
	});

	it("rejects a malformed payload on the wire", async () => {
		await expect(invitePatientFn({ data: { patientId: "x" } })).rejects.toThrow();
	});
});

describe("approvePatientLinkFn / revokePatientLinkFn", () => {
	it("apply the change through the service", async () => {
		await expect(approvePatientLinkFn({ data: 7 })).resolves.toEqual({
			ok: true,
		});
		expect(links.approve).toHaveBeenCalledWith(7);
		links.revoke.mockReturnValue(Effect.succeed(false));
		await expect(revokePatientLinkFn({ data: 7 })).resolves.toEqual({
			ok: false,
		});
		expect(links.revoke).toHaveBeenCalledWith(7);
	});

	it("refuse denied changes and non-doctors", async () => {
		links.approve.mockReturnValue(denied);
		await expect(approvePatientLinkFn({ data: 7 })).resolves.toEqual({
			ok: false,
		});
		mocks.getDoctorUser.mockResolvedValue(null);
		await expect(revokePatientLinkFn({ data: 7 })).resolves.toEqual({
			ok: false,
		});
	});
});

describe("portalReadersFn", () => {
	it("returns the registered devices of active links + ciphered records", async () => {
		await expect(portalReadersFn({ data: 1 })).resolves.toEqual({
			readers: [
				{ readerId: "ana", wrapPublicKey: "anaDev1" },
				{ readerId: "ana", wrapPublicKey: "anaDev2" },
			],
			cipheredConsultationIds: [10, 12],
		});
		expect(mocks.runAs).toHaveBeenCalledWith(acting, expect.anything());
		expect(links.list).toHaveBeenCalledWith(1);
	});

	it("returns an empty plan when nobody holds an active link", async () => {
		await expect(portalReadersFn({ data: 2 })).resolves.toEqual({
			readers: [],
			cipheredConsultationIds: [],
		});
	});

	it("is null for non-doctors and for foreign patients", async () => {
		mocks.getDoctorUser.mockResolvedValue(null);
		await expect(portalReadersFn({ data: 1 })).resolves.toBeNull();
		mocks.getDoctorUser.mockResolvedValue(acting);
		links.list.mockReturnValue(denied);
		await expect(portalReadersFn({ data: 1 })).resolves.toBeNull();
	});
});
