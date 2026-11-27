import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Anamnesis } from "@ktb/anamnesis";
import { createPatient } from "@ktb/patients";
import { validatePatient } from "@ktb/patients/record";
import { attachAudioRecord, createConsultation } from "@ktb/consultations";
import { consultations } from "@ktb/db/schema";
import { audioBucketStore } from "#/test/cloudflare-workers.ts";

const correct = vi.hoisted(() => vi.fn());

// Real platform composition (db, bucket + ai doubles, runtime) — only the
// LLM cleanup is replaced so each outcome can be forced.
vi.mock("#/lib/platform.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/platform.ts")>()),
	correctTranscript: (input: { text: string }) => correct(input.text),
}));

import { db } from "#/lib/platform.ts";
import { handleAudioQueueBatch, type QueueMessageLike } from "./audio-jobs.ts";

const AUDIO_KEY = "audio/u1/1/platform.webm";

const seed = async () => {
	const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
	audioBucketStore.set(AUDIO_KEY, { data: new Uint8Array([1, 2, 3]) });
	await attachAudioRecord(db, id, { audioKey: AUDIO_KEY, size: 3 });
	return id;
};

const row = async (id: number) =>
	(await db.select().from(consultations).where(eq(consultations.id, id)))[0];

const message = (id: number, log: string[]): QueueMessageLike => ({
	body: { consultationId: id, audioKey: AUDIO_KEY, userId: "u1" },
	ack: () => log.push("ack"),
	retry: () => log.push("retry"),
});

beforeEach(() => {
	correct.mockReset();
});

describe("handleAudioQueueBatch with the platform deps", () => {
	it("transcribes with the bound bucket and ai, then stores the cleaned transcript", async () => {
		correct.mockResolvedValue({ corrected: "Transcrição corrigida.", engine: "test-llm" });
		const id = await seed();
		const log: string[] = [];
		await handleAudioQueueBatch([message(id, log)]);
		expect(log).toEqual(["ack"]);
		expect(correct).toHaveBeenCalledWith("transcrição do servidor");
		const r = await row(id);
		expect(r?.audioStatus).toBe("done");
		expect(r?.serverTranscript).toBe("transcrição do servidor");
		expect(r?.correctedTranscript).toBe("Transcrição corrigida.");
	});

	it("treats a failing cleanup as no correction instead of failing the job", async () => {
		correct.mockRejectedValue(new Error("llm down"));
		const id = await seed();
		const log: string[] = [];
		await handleAudioQueueBatch([message(id, log)]);
		expect(log).toEqual(["ack"]);
		const r = await row(id);
		expect(r?.audioStatus).toBe("done");
		expect(r?.correctedTranscript).toBeNull();
	});

	it("accepts caller-supplied deps instead of the platform defaults", async () => {
		// Missing consultation → permanent failure → ack; the injected
		// deps never touch bucket/ai.
		const log: string[] = [];
		await handleAudioQueueBatch([message(424242, log)], {
			db,
			bucket: undefined,
			ai: undefined,
			model: "test-model",
			correctTranscript: async () => null,
		});
		expect(log).toEqual(["ack"]);
	});
});

// ── PL-023: post-cleanup anamnesis regeneration ─────────────────
// `handleAudioQueueBatch` wires `regenerateAnamnesis` into the real
// service path: owner lookup → Consultations.get → AnamnesisEngine
// extract → attachAnamnesis. Rows the physician already approved
// (anamnesis_reviewed_version bound) or that never had a draft are
// left alone.

const section = (content: string) => ({
	content,
	confidence: "alta" as const,
	evidence: ["frase"],
});

const SEED_ANAMNESIS: Anamnesis = {
	queixa_principal: section("seed complaint"),
	hda: section("seed hda"),
	antecedentes: section("seed ant"),
	alergias: section("seed alg"),
	medicamentos_em_uso: section("seed med"),
	exame_fisico: section("seed exame"),
	hipoteses: section("seed hip"),
	conduta: section("seed cond"),
};

const seedWithAnamnesis = async (
	opts: {
		patientId?: number;
		reviewed?: boolean;
		anonymousRow?: boolean;
	} = {},
) => {
	const id = await seed();
	await db
		.update(consultations)
		.set({
			anamnesis: JSON.stringify(SEED_ANAMNESIS),
			...(opts.patientId !== undefined ? { patientId: opts.patientId } : {}),
			...(opts.reviewed === true
				? {
						anamnesisReviewedVersion: 1,
						anamnesisReviewedAt: new Date(),
						anamnesisReviewedBy: "u1",
					}
				: {}),
			// A row with no owner id short-circuits before the service
			// path — the consumer must not fail the job over it.
			...(opts.anonymousRow === true ? { userId: null } : {}),
		})
		.where(eq(consultations.id, id));
	return id;
};

const runJob = async (id: number) => {
	correct.mockResolvedValue({ corrected: "Transcrição corrigida.", engine: "test-llm" });
	const log: string[] = [];
	await handleAudioQueueBatch([message(id, log)]);
	expect(log).toEqual(["ack"]);
};

describe("anamnesis regeneration after transcript cleanup", () => {
	it("regenerates the draft from the corrected transcript", async () => {
		const id = await seedWithAnamnesis();
		await runJob(id);
		const r = await row(id);
		expect(r?.correctedTranscript).toBe("Transcrição corrigida.");
		// The save-time draft was replaced and versioned — the physician
		// approval stamp stays empty so the queue still flags the row.
		expect(r?.anamnesis).not.toBe(JSON.stringify(SEED_ANAMNESIS));
		expect(r?.anamnesisVersion).not.toBeNull();
		expect(r?.anamnesisReviewedVersion).toBeNull();
	});

	it("passes the patient's history into extraction when linked", async () => {
		const fields = validatePatient({ name: "Ana Silva", birthDate: "1984" });
		if (!fields.ok) throw new Error("fixture");
		const patient = await createPatient(db, "u1", fields.fields);
		const id = await seedWithAnamnesis({ patientId: patient!.id });
		await runJob(id);
		const r = await row(id);
		expect(r?.anamnesis).not.toBe(JSON.stringify(SEED_ANAMNESIS));
		expect(r?.anamnesisVersion).not.toBeNull();
	});

	it("leaves physician-approved anamneses untouched", async () => {
		const id = await seedWithAnamnesis({ reviewed: true });
		await runJob(id);
		const r = await row(id);
		expect(r?.anamnesis).toBe(JSON.stringify(SEED_ANAMNESIS));
		expect(r?.anamnesisReviewedVersion).toBe(1);
	});

	it("no-ops on rows without an owner or a prior draft", async () => {
		const anonymous = await seedWithAnamnesis({ anonymousRow: true });
		await runJob(anonymous);
		expect((await row(anonymous))?.anamnesis).toBe(JSON.stringify(SEED_ANAMNESIS));

		// No anamnesis column at all → nothing to regenerate from.
		const bare = await seed();
		await runJob(bare);
		expect((await row(bare))?.anamnesis).toBeNull();
	});

	it("no-ops when the row is not visible to its recorded owner", async () => {
		// Row exists (audioJobRecord finds it) but the owner tuple is
		// gone — Consultations.get reports Forbidden → treated as null.
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		audioBucketStore.set(AUDIO_KEY, { data: new Uint8Array([1, 2, 3]) });
		await attachAudioRecord(db, id, { audioKey: AUDIO_KEY, size: 3 });
		await db
			.update(consultations)
			.set({ anamnesis: JSON.stringify(SEED_ANAMNESIS) })
			.where(eq(consultations.id, id));
		const { deleteRelationTuples } = await import("@ktb/rbac");
		await deleteRelationTuples(db, {
			objectType: "consultation",
			objectId: String(id),
			relation: "owner",
		});
		await runJob(id);
		expect((await row(id))?.anamnesis).toBe(JSON.stringify(SEED_ANAMNESIS));
	});
});
