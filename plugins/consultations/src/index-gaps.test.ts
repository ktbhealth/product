import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Principal } from "@ktb/authz";
import { buildPermissions, Permissions } from "@ktb/rbac";
import { PatientsCommandsLive, PatientsQueriesLive } from "@ktb/patients";
import { makeEventBus } from "@effect-server-utils/cqrs";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { consultations as consultationsTable } from "@ktb/db/schema";
import {
	Consultations,
	ConsultationsLive,
	attachAudioRecord,
	audioJobRecord,
	audioJobRow,
	consultationTenantId,
	createConsultation,
} from "./index.ts";

// Branch/function gaps in index.ts that the main suite does not reach:
// optional audio fields, missing rows and unowned consultations.

const DDL = `
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0);
`;

const liveDeps = (db: ReturnType<typeof makeDb>) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		Layer.succeed(Permissions, buildPermissions(db)),
		makeEventBus(),
	);
	return Layer.mergeAll(
		infra,
		Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(Layer.provide(infra)),
	);
};

const asUser = <A, E, R>(
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
	userId: string,
	effect: Effect.Effect<A, E, R>,
) => runtime.runPromise(Effect.provideService(effect, Principal, { userId }));

describe("audio record helpers", () => {
	let db: ReturnType<typeof makeDb>;
	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
	});

	it("stores null content type and size when they are not provided", async () => {
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/k.webm" });
		const record = await audioJobRecord(db, id);
		expect(record).toMatchObject({ audioKey: "audio/u1/k.webm", audioStatus: "stored" });
		const [row] = await db
			.select({ type: consultationsTable.audioContentType, size: consultationsTable.audioSize })
			.from(consultationsTable)
			.where(eq(consultationsTable.id, id));
		expect(row).toEqual({ type: null, size: null });
	});

	it("audioJobRow is null for an unknown consultation", async () => {
		await expect(audioJobRow(db, 987654)).resolves.toBeNull();
	});

	it("consultationTenantId reports the row's tenant scope for system paths", async () => {
		const personal = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		const shared = (await createConsultation(db, { userId: "u1", source: "browser" }, 7))!;
		await expect(consultationTenantId(db, personal)).resolves.toBeNull();
		await expect(consultationTenantId(db, shared)).resolves.toBe(7);
		await expect(consultationTenantId(db, 424244)).resolves.toBeNull();
	});
});

describe("ConsultationsLive on unknown consultations", () => {
	let db: ReturnType<typeof makeDb>;
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provide(liveDeps(db))));
	});
	afterAll(() => runtime.dispose());

	it("attachAudio skips the owner check when no row exists and publishes nothing", async () => {
		await asUser(
			runtime,
			"u1",
			call((c) => c.attachAudio("u1", { consultationId: 424242, audioKey: "k" })),
		);
		// The after-commit subscriber re-reads the row; a missing one emits nothing.
		await new Promise((r) => setTimeout(r, 50));
		await expect(audioJobRow(db, 424242)).resolves.toBeNull();
	});

	it("updateAudioStatus skips the owner check when no row exists", async () => {
		await asUser(
			runtime,
			"u1",
			call((c) => c.updateAudioStatus("u1", 424243, "queued")),
		);
		await new Promise((r) => setTimeout(r, 50));
		await expect(audioJobRow(db, 424243)).resolves.toBeNull();
	});
});

const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
	Effect.flatMap(Consultations, f);

describe("Consultations.create when the insert returns no row", () => {
	it("returns null and dispatches no creation event", async () => {
		const emptyInsert = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as ReturnType<typeof makeDb>;
		const runtime = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provide(liveDeps(emptyInsert))),
		);
		try {
			const id = await asUser(
				runtime,
				"u1",
				call((c) => c.create({ userId: "u1", source: "browser" })),
			);
			expect(id).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});
});
