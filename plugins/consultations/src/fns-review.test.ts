import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const mocks = vi.hoisted(() => ({
	getDoctorUser: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "u1" })),
	runAs: vi.fn<(user: unknown, effect: unknown) => Promise<unknown>>(async () => ({ id: 1 })),
	reviewTranscript: vi.fn(),
	approveAnamnesis: vi.fn(),
	attachAnamnesis: vi.fn(),
	deferConsultation: vi.fn(),
	nextPendingReview: vi.fn(),
	countPendingReview: vi.fn(),
	saveTranscriptEdits: vi.fn(),
}));

// Same fake as fns-zk.test.ts: handlers run as plain async fns and the
// validator is applied to the incoming `data`.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", () => ({
	ensureDoctorUser: vi.fn(async () => ({ id: "u1" })),
	ensureSessionUser: vi.fn(async () => ({ id: "u1" })),
	getDoctorAccess: vi.fn(),
	getDoctorContext: vi.fn(),
	getDoctorUser: mocks.getDoctorUser,
	getLocale: vi.fn(),
	getServerRuntime: vi.fn(),
	getSessionUser: vi.fn(),
	purgeAudio: vi.fn(),
	runAs: mocks.runAs,
}));

import { Consultations } from "./index.ts";
import { Forbidden } from "@ktb/authz";
import {
	approveAnamnesisFn,
	editAnamnesisFn,
	countPendingReviewFn,
	deferConsultationFn,
	nextPendingReviewFn,
	saveTranscriptEditsFn,
	reviewTranscriptFn,
} from "./fns.ts";

/** Make `runAs` execute the effect against a minimal Consultations
 * service — the three review methods the fns delegate to. */
const runEffects = () => {
	mocks.runAs.mockImplementation(async (_user, effect) =>
		Effect.runPromise(
			Effect.provide(
				effect as Effect.Effect<unknown, unknown>,
				Layer.succeed(Consultations, {
					reviewTranscript: mocks.reviewTranscript,
					approveAnamnesis: mocks.approveAnamnesis,
					attachAnamnesis: mocks.attachAnamnesis,
					deferConsultation: mocks.deferConsultation,
					nextPendingReview: mocks.nextPendingReview,
					countPendingReview: mocks.countPendingReview,
					saveTranscriptEdits: mocks.saveTranscriptEdits,
				} as unknown as Consultations["Service"]),
			),
		),
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reviewTranscript.mockReturnValue(Effect.succeed(undefined));
	mocks.approveAnamnesis.mockReturnValue(Effect.succeed(undefined));
	mocks.attachAnamnesis.mockReturnValue(Effect.succeed(undefined));
	mocks.deferConsultation.mockReturnValue(Effect.succeed(undefined));
	mocks.nextPendingReview.mockReturnValue(Effect.succeed(44));
	mocks.countPendingReview.mockReturnValue(Effect.succeed(3));
	mocks.saveTranscriptEdits.mockReturnValue(Effect.succeed(undefined));
});

describe("review server fns (PL-022)", () => {
	it("reviewTranscriptFn delegates to the service", async () => {
		runEffects();
		await expect(reviewTranscriptFn({ data: 7 } as never)).resolves.toEqual({ ok: true });
		expect(mocks.reviewTranscript).toHaveBeenCalledWith(7, "u1");
	});

	it("approveAnamnesisFn delegates to the service", async () => {
		runEffects();
		await expect(approveAnamnesisFn({ data: 8 } as never)).resolves.toEqual({ ok: true });
		expect(mocks.approveAnamnesis).toHaveBeenCalledWith(8, "u1");
	});

	it("deferConsultationFn decodes the ISO date and forwards it", async () => {
		runEffects();
		await expect(
			deferConsultationFn({ data: { id: 9, until: "2030-01-15T00:00:00.000Z" } } as never),
		).resolves.toEqual({ ok: true });
		expect(mocks.deferConsultation).toHaveBeenCalledWith(
			9,
			"u1",
			new Date("2030-01-15T00:00:00.000Z"),
		);
	});

	it("deferConsultationFn forwards null until (clear) and an omitted until", async () => {
		runEffects();
		await expect(deferConsultationFn({ data: { id: 9, until: null } } as never)).resolves.toEqual({
			ok: true,
		});
		expect(mocks.deferConsultation).toHaveBeenLastCalledWith(9, "u1", null);
		await expect(deferConsultationFn({ data: { id: 10 } } as never)).resolves.toEqual({
			ok: true,
		});
		expect(mocks.deferConsultation).toHaveBeenLastCalledWith(10, "u1", null);
	});

	it("collapses Forbidden to { ok: false }", async () => {
		mocks.reviewTranscript.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		mocks.approveAnamnesis.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		mocks.deferConsultation.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		runEffects();
		await expect(reviewTranscriptFn({ data: 1 } as never)).resolves.toEqual({ ok: false });
		await expect(approveAnamnesisFn({ data: 1 } as never)).resolves.toEqual({ ok: false });
		await expect(deferConsultationFn({ data: { id: 1, until: null } } as never)).resolves.toEqual({
			ok: false,
		});
	});

	it("returns { ok: false } without a session user", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(reviewTranscriptFn({ data: 1 } as never)).resolves.toEqual({ ok: false });
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(approveAnamnesisFn({ data: 1 } as never)).resolves.toEqual({ ok: false });
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(deferConsultationFn({ data: { id: 1, until: null } } as never)).resolves.toEqual({
			ok: false,
		});
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	const DOC = {
		queixa_principal: { content: "dor", confidence: "alta", evidence: [], edited: true },
		hda: { content: "h", confidence: "alta", evidence: [] },
		antecedentes: { content: "a", confidence: "alta", evidence: [] },
		alergias: { content: "a", confidence: "alta", evidence: [] },
		medicamentos_em_uso: { content: "m", confidence: "alta", evidence: [] },
		exame_fisico: { content: "e", confidence: "alta", evidence: [] },
		hipoteses: { content: "h", confidence: "alta", evidence: [] },
		conduta: { content: "c", confidence: "alta", evidence: [] },
	};
	it("editAnamnesisFn delegates to attachAnamnesis under the manual-edit engine", async () => {
		await expect(
			editAnamnesisFn({ data: { consultationId: 7, anamnesis: DOC } }),
		).resolves.toEqual({ ok: true });
		expect(mocks.attachAnamnesis).toHaveBeenCalledWith("u1", {
			consultationId: 7,
			anamnesis: DOC,
			engine: "manual-edit",
			version: undefined,
		});
	});

	it("editAnamnesisFn is { ok: false } without a session user", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(
			editAnamnesisFn({ data: { consultationId: 7, anamnesis: DOC } }),
		).resolves.toEqual({ ok: false });
	});

	it("editAnamnesisFn collapses Forbidden to { ok: false }", async () => {
		mocks.attachAnamnesis.mockReturnValueOnce(Effect.fail(new Forbidden({ action: "x" })));
		await expect(
			editAnamnesisFn({ data: { consultationId: 7, anamnesis: DOC } }),
		).resolves.toEqual({ ok: false });
	});

	it("editAnamnesisFn rejects a string anamnesis without the ciphered flag", async () => {
		await expect(
			editAnamnesisFn({ data: { consultationId: 7, anamnesis: "v1.wire" } }),
		).resolves.toEqual({ ok: false });
		expect(mocks.attachAnamnesis).not.toHaveBeenCalled();
	});

	it("nextPendingReviewFn returns the next queue id", async () => {
		runEffects();
		await expect(nextPendingReviewFn({ data: 9 } as never)).resolves.toEqual({ id: 44 });
		expect(mocks.nextPendingReview).toHaveBeenCalledWith(9, "u1");
	});

	it("nextPendingReviewFn collapses Forbidden to { id: null }", async () => {
		mocks.nextPendingReview.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		runEffects();
		await expect(nextPendingReviewFn({ data: 9 } as never)).resolves.toEqual({ id: null });
	});

	it("nextPendingReviewFn is { id: null } without a session user", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(nextPendingReviewFn({ data: 9 } as never)).resolves.toEqual({ id: null });
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("countPendingReviewFn returns the queue depth", async () => {
		runEffects();
		await expect(countPendingReviewFn({} as never)).resolves.toEqual({ count: 3 });
		expect(mocks.countPendingReview).toHaveBeenCalledWith("u1");
	});

	it("countPendingReviewFn collapses Forbidden to { count: 0 }", async () => {
		mocks.countPendingReview.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		runEffects();
		await expect(countPendingReviewFn({} as never)).resolves.toEqual({ count: 0 });
	});

	it("countPendingReviewFn is { count: 0 } without a session user", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(countPendingReviewFn({} as never)).resolves.toEqual({ count: 0 });
		expect(mocks.runAs).not.toHaveBeenCalled();
	});
});

describe("saveTranscriptEditsFn (PL-023)", () => {
	it("delegates id + edits to the service", async () => {
		runEffects();
		const edits = JSON.stringify([{ at: "2026-01-01T00:00:00Z", by: "u1", u: "AAAA" }]);
		await expect(saveTranscriptEditsFn({ data: { id: 7, edits } } as never)).resolves.toEqual({
			ok: true,
		});
		expect(mocks.saveTranscriptEdits).toHaveBeenCalledWith(7, "u1", edits);
	});

	it("collapses Forbidden to { ok: false }", async () => {
		mocks.saveTranscriptEdits.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		runEffects();
		await expect(saveTranscriptEditsFn({ data: { id: 7, edits: "[]" } } as never)).resolves.toEqual(
			{ ok: false },
		);
	});

	it("returns { ok: false } without a session user", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce(null);
		await expect(saveTranscriptEditsFn({ data: { id: 7, edits: "[]" } } as never)).resolves.toEqual(
			{ ok: false },
		);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});
});
