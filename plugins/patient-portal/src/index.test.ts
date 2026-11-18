import { afterAll, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { Anamnesis, AnamnesisSection } from "@ktb/anamnesis/types";
import { Audit, type AuditEntryInput } from "@ktb/audit";
import { Consultations } from "@ktb/consultations";
import { Doctors } from "@ktb/doctors";
import { Patients } from "@ktb/patients";
import { PortalAccess } from "@ktb/patient-access";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	parseAnamnesis,
	PatientPortal,
	PatientPortalLive,
	patientPortalChromePlugin,
	patientPortalInstancePlugin,
	patientPortalPagesPlugin,
	patientPortalRoutesPlugin,
	patientPortalServicesPlugin,
	plugins,
	portalSections,
} from "./index.ts";

// The page loaders resolve the request's patient context through
// @ktb/server-fns; outside a request there is none, so the mock is the
// only way to drive the activity loader's open-record branches.
const mocks = vi.hoisted(() => ({ patientContext: vi.fn() }));
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return { ...actual, getPatientContext: mocks.patientContext };
});

const section = (content: string): AnamnesisSection => ({
	content,
	confidence: "alta",
	// Transcript sentences — must never reach the portal.
	evidence: ["o paciente disse isso"],
});

const anamnesis = (overrides: Partial<Anamnesis> = {}): Anamnesis => ({
	queixa_principal: section("Dor de cabeça há três dias"),
	hda: section("Início súbito, piora à noite"),
	antecedentes: section(""),
	alergias: section("  "),
	medicamentos_em_uso: section("Losartana 50 mg"),
	exame_fisico: section("A preencher pelo médico: exame físico."),
	hipoteses: section("Cefaleia tensional"),
	conduta: section("Retorno em 15 dias"),
	historico: section("2 consultas anteriores"),
	...overrides,
});

const json = (a: Anamnesis) => JSON.stringify(a);

/** Structural twin of `@ktb/auth`'s PatientProfile — the package is
 * not a declared dep of this plugin, and the stub only needs the shape. */
type Link = { patientId: number; name: string; relation: "self" | "guardian" };

const profile = (patientId: number, name = "Ana"): Link => ({
	patientId,
	name,
	relation: "self",
});

type PortalRow = {
	id: number;
	createdAt: Date;
	patientId: number;
	tenantId: number | null;
	userId: string | null;
	anamnesis: string;
};

const portalRow = (overrides: Partial<PortalRow> = {}): PortalRow => ({
	id: 10,
	createdAt: new Date(1_000_000),
	patientId: 1,
	tenantId: 7,
	userId: "doc",
	anamnesis: json(anamnesis()),
	...overrides,
});

interface Stubs {
	readonly links?: Record<number, Link>;
	readonly awaiting?: number;
	readonly list?: { id: number; createdAt: Date; anamnesis: string }[];
	readonly get?: PortalRow | null;
	readonly scopes?: Record<number, { patientId: number; tenantId: number | null } | null>;
	readonly owners?: Record<number, { ownerId: string; tenantId: number | null } | null>;
	readonly doctorNames?: Record<string, string | null>;
}

/** The four owner services the portal composes — stubbed at their
 * Tags, so these tests exercise orchestration only (the link/row SQL
 * lives in — and is tested by — the owner plugins). */
const ownerLayers = (stubs: Stubs) => {
	const access = Layer.succeed(PortalAccess, {
		link: (patientId: number) => Effect.succeed(stubs.links?.[patientId] ?? null),
		awaitingInvites: () => Effect.succeed(stubs.awaiting ?? 0),
	});
	const consultations = Layer.succeed(Consultations, {
		// The owner gates on the active link — the stub mirrors that so a
		// caller without one gets the same empty answer.
		portalList: (patientId: number) =>
			Effect.succeed(stubs.links?.[patientId] === undefined ? [] : (stubs.list ?? [])),
		portalGet: () => Effect.succeed(stubs.get ?? null),
		portalScope: (id: number) => Effect.succeed(stubs.scopes?.[id] ?? null),
	} as never);
	const doctors = Layer.succeed(Doctors, {
		displayName: (userId: string) => Effect.succeed(stubs.doctorNames?.[userId] ?? null),
	} as never);
	const patients = Layer.succeed(Patients, {
		ownerOf: (id: number) => Effect.succeed(stubs.owners?.[id] ?? null),
	} as never);
	return Layer.mergeAll(access, consultations, doctors, patients);
};

// Vault's portal helpers are real repo functions — the D1 carries only
// the tables they touch (portal_keys + entity_deks; user satisfies the
// FK stub). Patient 1 is tenant 7 with grants for ana's device; 2 is
// tenantless; 3 belongs to a stranger.
const VAULT_DDL = `
CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
INSERT INTO user (id, name, email) VALUES ('ana', 'Ana', 'ana@ktb.test');
CREATE TABLE portal_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE cascade, wrap_public_key TEXT NOT NULL, sign_public_key TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO portal_keys (user_id, wrap_public_key, sign_public_key) VALUES ('ana', 'anaDev', 'anaSign');
CREATE TABLE entity_deks (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, reader_kind TEXT NOT NULL, reader_pubkey TEXT NOT NULL, reader_id TEXT, wrapped_dek TEXT NOT NULL, granted_by_user_id TEXT, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO entity_deks (tenant_id, entity_type, entity_id, reader_kind, reader_pubkey, wrapped_dek) VALUES
  (7, 'patient', '1', 'patient', 'anaDev', 'w1.patient'),
  (7, 'consultation', '10', 'patient', 'anaDev', 'w1.consult');
`;

const runtimes: ManagedRuntime.ManagedRuntime<PatientPortal, never>[] = [];

const makeRuntime = (stubs: Stubs = {}, db: ReturnType<typeof makeDb> = makeDb(makeD1(""))) => {
	const runtime = ManagedRuntime.make(
		PatientPortalLive.pipe(
			Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), ownerLayers(stubs))),
		),
	);
	runtimes.push(runtime);
	return runtime;
};

afterAll(async () => {
	await Promise.all(runtimes.map((runtime) => runtime.dispose()));
});

type Who = { userId: string; actorId?: string } | null;
const as = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<PatientPortal, never>,
	who: Who,
	use: (portal: PatientPortal["Service"]) => Effect.Effect<A, E>,
) =>
	runtime.runPromise(
		Effect.flatMap(PatientPortal, use).pipe(Effect.provideService(Principal, who), Effect.result),
	);
const ana: Who = { userId: "ana" };

describe("portalSections", () => {
	it("keeps what the doctor wrote, in document order, without drafting metadata", () => {
		expect(portalSections(anamnesis())).toEqual([
			{ key: "queixa_principal", content: "Dor de cabeça há três dias" },
			{ key: "hda", content: "Início súbito, piora à noite" },
			{ key: "medicamentos_em_uso", content: "Losartana 50 mg" },
			{ key: "hipoteses", content: "Cefaleia tensional" },
			{ key: "conduta", content: "Retorno em 15 dias" },
		]);
	});

	it("drops blank sections and the drafter's placeholder", () => {
		const keys = portalSections(anamnesis()).map((s) => s.key);
		expect(keys).not.toContain("antecedentes");
		expect(keys).not.toContain("alergias");
		expect(keys).not.toContain("exame_fisico");
	});
});

describe("parseAnamnesis", () => {
	it("decodes a stored document and reports null on any drift", () => {
		expect(parseAnamnesis(json(anamnesis()))?.queixa_principal.content).toBe(
			"Dor de cabeça há três dias",
		);
		expect(parseAnamnesis(null)).toBeNull();
		expect(parseAnamnesis("not json")).toBeNull();
	});
});

describe("PatientPortal.profile", () => {
	const stubs: Stubs = {
		links: {
			1: profile(1),
			2: { patientId: 2, name: "Leo", relation: "guardian" },
			4: profile(4, "Max"),
		},
		owners: {
			1: { ownerId: "doc", tenantId: 7 },
			2: { ownerId: "other", tenantId: null },
			// 4 resolves no owner row — doctorName stays null.
		},
		doctorNames: { doc: "Dra. Bia" },
	};
	const runtime = makeRuntime(stubs);

	it("names the record and the doctor who keeps it", async () => {
		expect(await as(runtime, ana, (p) => p.profile(1))).toMatchObject({
			_tag: "Success",
			success: { patientId: 1, relation: "self", name: "Ana", doctorName: "Dra. Bia" },
		});
	});

	it("has no doctor name when the owner has no profile or the lookup misses", async () => {
		// 2's owner "other" has no doctors row; 4's owner lookup misses.
		for (const patientId of [2, 4]) {
			expect(await as(runtime, ana, (p) => p.profile(patientId))).toMatchObject({
				_tag: "Success",
				success: { doctorName: null },
			});
		}
	});

	it("fails Forbidden without an active link or a principal", async () => {
		expect(await as(runtime, ana, (p) => p.profile(3))).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "Forbidden" },
		});
		expect(await as(runtime, null, (p) => p.profile(1))).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "Forbidden" },
		});
	});
});

describe("PatientPortal.consultations", () => {
	const stubs: Stubs = {
		links: { 1: profile(1) },
		list: [
			{
				id: 11,
				createdAt: new Date(2_000_000),
				anamnesis: json(anamnesis({ queixa_principal: section("Retorno") })),
			},
			{ id: 10, createdAt: new Date(1_000_000), anamnesis: json(anamnesis()) },
			{ id: 12, createdAt: new Date(500_000), anamnesis: "v1.envelope" },
			{ id: 13, createdAt: new Date(400_000), anamnesis: "not json" },
		],
	};
	const runtime = makeRuntime(stubs);

	it("lists the saved records newest first, envelopes opaque", async () => {
		const listed = await as(runtime, ana, (p) => p.consultations(1));
		expect(listed).toMatchObject({
			_tag: "Success",
			success: [
				{ id: 11, chiefComplaint: "Retorno", anamnesis: null },
				{ id: 10, chiefComplaint: "Dor de cabeça há três dias", anamnesis: null },
				{ id: 12, chiefComplaint: null, anamnesis: "v1.envelope" },
			],
		});
	});

	it("is empty for a record the caller holds no link to", async () => {
		expect(await as(runtime, ana, (p) => p.consultations(2))).toMatchObject({
			_tag: "Success",
			success: [],
		});
	});
});

describe("PatientPortal.consultation", () => {
	const calls: AuditEntryInput[] = [];
	const auditStub = Layer.succeed(Audit, {
		record: (entry: AuditEntryInput) =>
			Effect.sync(() => {
				calls.push(entry);
			}),
		adminList: () => Effect.die("unused"),
		adminVerify: () => Effect.die("unused"),
		activityAccess: () => Effect.succeed(false),
		activityList: () => Effect.die("unused"),
		patientList: () => Effect.die("unused"),
	} as never);
	const stubs: Stubs = {
		links: { 1: profile(1) },
		get: portalRow(),
		doctorNames: { doc: "Dra. Bia" },
	};
	// provideMerge (not provide): `audit()` resolves Audit via
	// serviceOption per call, so the stub must stay in the runtime env.
	const runtime = ManagedRuntime.make(
		PatientPortalLive.pipe(
			Layer.provideMerge(
				Layer.mergeAll(Layer.succeed(Db, makeDb(makeD1(""))), ownerLayers(stubs), auditStub),
			),
		),
	);
	runtimes.push(runtime);

	it("returns the saved record with who it is about and who recorded it", async () => {
		const result = await as(runtime, ana, (p) => p.consultation(10));
		expect(result).toMatchObject({
			_tag: "Success",
			success: { id: 10, patientId: 1, patientName: "Ana", doctorName: "Dra. Bia" },
		});
		const wire = JSON.stringify(result._tag === "Success" ? result.success : null);
		expect(wire).not.toContain("o paciente disse isso");
		expect(wire).not.toContain("confidence");
		expect(wire).not.toContain("2 consultas anteriores");
	});

	it("emits consultations.read with via portal and the row tenant", async () => {
		calls.length = 0;
		await as(runtime, ana, (p) => p.consultation(10));
		expect(calls).toEqual([
			{
				action: "consultations.read",
				targetType: "consultation",
				targetId: 10,
				tenantId: 7,
				detail: { patientId: 1, via: "portal" },
			},
		]);
	});

	it("reports no recording doctor when the row has no user", async () => {
		const anonymous = makeRuntime({ ...stubs, get: portalRow({ userId: null }) });
		const result = await as(anonymous, ana, (p) => p.consultation(10));
		expect(result).toMatchObject({
			_tag: "Success",
			success: { doctorName: null },
		});
	});

	it("ships a ZK row's envelope untouched, with no sections", async () => {
		const zkRuntime = makeRuntime({ ...stubs, get: portalRow({ anamnesis: "v1.ct" }) });
		expect(await as(zkRuntime, ana, (p) => p.consultation(10))).toMatchObject({
			_tag: "Success",
			success: { anamnesis: "v1.ct", sections: [] },
		});
	});

	it("fails Forbidden for missing, unreadable or unlinked records", async () => {
		const missing = makeRuntime({ ...stubs, get: null });
		const unreadable = makeRuntime({ ...stubs, get: portalRow({ anamnesis: "not json" }) });
		const unlinked = makeRuntime({ ...stubs, links: {} });
		for (const r of [missing, unreadable, unlinked]) {
			const result = await as(r, ana, (p) => p.consultation(10));
			expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } });
		}
	});
});

describe("PatientPortal.awaitingInvites", () => {
	const runtime = makeRuntime({ awaiting: 2 });

	it("reports the invites waiting on email verification", async () => {
		expect(await as(runtime, ana, (p) => p.awaitingInvites())).toMatchObject({
			_tag: "Success",
			success: 2,
		});
	});

	it("fails Forbidden for anonymous and delegated principals", async () => {
		for (const who of [null, { userId: "ana", actorId: "sec" }]) {
			expect(await as(runtime, who, (p) => p.awaitingInvites())).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "Forbidden" },
			});
		}
	});
});

describe("PatientPortal ZK surface", () => {
	const db = makeDb(makeD1(VAULT_DDL));
	const runtime = makeRuntime(
		{
			// ana holds active links to patients 1 (tenant 7, granted) and
			// 2 (tenantless); patient 3 has an owner row but no link.
			links: { 1: profile(1), 2: profile(2, "Livre") },
			scopes: {
				10: { patientId: 1, tenantId: 7 },
				11: null, // patient-less consultation
				12: { patientId: 1, tenantId: 7 },
				999: null,
			},
			owners: {
				1: { ownerId: "doc", tenantId: 7 },
				2: { ownerId: "doc", tenantId: null },
				3: { ownerId: "other", tenantId: 7 },
			},
		},
		db,
	);

	it("registers the caller's device idempotently", async () => {
		const input = { wrapPublicKey: "newDev", signPublicKey: "newSign" };
		const first = await as(runtime, ana, (p) => p.registerDevice(input));
		const second = await as(runtime, ana, (p) => p.registerDevice(input));
		expect(first).toMatchObject({ _tag: "Success", success: { userId: "ana" } });
		expect(second).toMatchObject({
			_tag: "Success",
			success: { id: first._tag === "Success" ? first.success.id : -1 },
		});
	});

	it("returns the caller's envelopes for the batch, absent when unreadable", async () => {
		const out = await as(runtime, ana, (p) =>
			p.dekEnvelopes({
				entityType: "consultation",
				entityIds: [10, 11, 12, 999, "bad"],
				wrapPublicKey: "anaDev",
			}),
		);
		// 10 has a grant; 11 is patient-less, 12 resolves but has none,
		// 999 is missing and "bad" is not an id — all absent.
		expect(out).toMatchObject({ _tag: "Success", success: { "10": "w1.consult" } });
	});

	it("serves patient envelopes through owner + link resolution", async () => {
		const out = await as(runtime, ana, (p) =>
			p.dekEnvelopes({
				entityType: "patient",
				entityIds: [1, 2, 3, 999],
				wrapPublicKey: "anaDev",
			}),
		);
		// 1: linked + granted. 2: tenantless — no grant can exist.
		// 3: owner resolves but ana holds no active link. 999: no owner.
		expect(out).toMatchObject({ _tag: "Success", success: { "1": "w1.patient" } });
	});

	it("is empty for an unregistered device and for strangers", async () => {
		expect(
			await as(runtime, ana, (p) =>
				p.dekEnvelopes({
					entityType: "consultation",
					entityIds: [10],
					wrapPublicKey: "otherDev",
				}),
			),
		).toMatchObject({ _tag: "Success", success: {} });
		expect(
			await as(runtime, { userId: "eva" }, (p) =>
				p.dekEnvelopes({
					entityType: "consultation",
					entityIds: [10],
					wrapPublicKey: "anaDev",
				}),
			),
		).toMatchObject({ _tag: "Success", success: {} });
	});

	it("refuses anonymous callers on the ZK surface", async () => {
		for (const result of [
			await as(runtime, null, (p) => p.registerDevice({ wrapPublicKey: "w", signPublicKey: "s" })),
			await as(runtime, null, (p) =>
				p.dekEnvelopes({ entityType: "patient", entityIds: [1], wrapPublicKey: "anaDev" }),
			),
		]) {
			expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } });
		}
	});
});

describe("patient-portal plugins", () => {
	it("contributes the service, the patient instance, its pages, chrome and the legacy redirects", () => {
		expect(plugins).toEqual([
			patientPortalServicesPlugin,
			patientPortalInstancePlugin,
			patientPortalPagesPlugin,
			patientPortalChromePlugin,
			patientPortalRoutesPlugin,
		]);
		expect(patientPortalServicesPlugin.id).toBe("patient-portal.services");
		expect(patientPortalServicesPlugin.services).toBe(PatientPortalLive);
		expect(patientPortalServicesPlugin.requiredDeps).toEqual([
			"patient-access.services",
			"consultations.services",
			"doctors.services",
			"patients.services",
		]);
		expect(patientPortalServicesPlugin.optionalDeps).toEqual(["audit.services"]);
		expect(patientPortalRoutesPlugin.id).toBe("patient-portal.routes");
		expect(patientPortalRoutesPlugin.routes).toHaveLength(1);
	});

	it("declares the patient instance — patient audience, session subject", () => {
		expect(patientPortalInstancePlugin.id).toBe("patient-portal.portal");
		expect(patientPortalInstancePlugin.portals).toEqual([
			{
				id: "patient",
				basePath: "/portal/patient",
				label: "Patient",
				audience: "patient",
			},
		]);
	});

	it("declares the home page and the consultation wildcard under the instance base", () => {
		const pages = patientPortalPagesPlugin.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual([
			"/portal/patient",
			"/portal/patient/consultations/*",
			"/portal/patient/activity",
		]);
		expect("loader" in pages[0]!).toBe(true);
		expect("guard" in pages[1]!).toBe(true);
		expect("loader" in pages[1]!).toBe(true);
		expect("loader" in pages[2]!).toBe(true);
	});

	it("scopes the sidebar entry to the patient instance and offers the patient login tile", () => {
		const entries = patientPortalChromePlugin.chrome ?? [];
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			region: "portal.sidebar",
			portal: "patient",
			content: { kind: "sidebarItem", item: { to: "/portal/patient", exact: true } },
		});
		expect(entries[1]).toMatchObject({
			id: "patient-portal.login.tile",
			region: "app.login.tiles",
			order: 0,
			content: {
				kind: "loginTile",
				to: "/login/patient",
				labelKey: "nav_patient_login",
			},
		});
	});
});

describe("patient-portal activity loader", () => {
	const page = patientPortalPagesPlugin.pages?.find((p) => p.id === "patient-portal.activity");
	const loader = () =>
		(
			page as unknown as {
				loader: (path: string) => Effect.Effect<unknown, unknown, never>;
			}
		).loader("/portal/patient/activity");

	const EMPTY = { entries: [], total: 0, limit: 100, offset: 0 };
	const openRecord = {
		user: { id: "ana", email: "ana@ktb.test", name: "Ana" },
		profiles: [{ patientId: 1, name: "Ana", relation: "self" }],
		active: { patientId: 1, name: "Ana", relation: "self" },
	};

	const auditStub = (
		patientList: (options: { patientId: number; limit?: number; offset?: number }) => unknown,
	) =>
		Layer.succeed(Audit, {
			record: () => Effect.void,
			adminList: () => Effect.die("unused"),
			adminVerify: () => Effect.die("unused"),
			activityAccess: () => Effect.succeed(false),
			activityList: () => Effect.die("unused"),
			patientList,
		} as never);

	it("fails closed to an empty page without an open record", async () => {
		mocks.patientContext.mockResolvedValue(null);
		await expect(Effect.runPromise(loader())).resolves.toEqual(EMPTY);
	});

	it("fails closed when no patient record is selected", async () => {
		mocks.patientContext.mockResolvedValue({ ...openRecord, active: null });
		await expect(Effect.runPromise(loader())).resolves.toEqual(EMPTY);
	});

	it("fails closed when the audit plugin is absent", async () => {
		mocks.patientContext.mockResolvedValue(openRecord);
		await expect(Effect.runPromise(loader())).resolves.toEqual(EMPTY);
	});

	it("serves the open record's feed through Audit.patientList", async () => {
		mocks.patientContext.mockResolvedValue(openRecord);
		const seen: { patientId: number; limit?: number; offset?: number }[] = [];
		const layer = auditStub((options) => {
			seen.push(options);
			return Effect.succeed({
				entries: [{ id: 1 }],
				total: 1,
				limit: options.limit ?? 100,
				offset: options.offset ?? 0,
			});
		});
		const result = await Effect.runPromise(loader().pipe(Effect.provide(layer)));
		expect(result).toEqual({ entries: [{ id: 1 }], total: 1, limit: 100, offset: 0 });
		expect(seen).toEqual([{ patientId: 1, limit: 100 }]);
	});

	it("fails closed when the audit check is denied", async () => {
		mocks.patientContext.mockResolvedValue(openRecord);
		const layer = auditStub(() => Effect.fail(new Forbidden({ path: "audit.patient" })));
		await expect(Effect.runPromise(loader().pipe(Effect.provide(layer)))).resolves.toEqual(EMPTY);
	});
});
