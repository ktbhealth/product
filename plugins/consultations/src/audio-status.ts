import { defineStateMachine } from "@ktb/statemachine";

/**
 * audio-status.ts — the `consultations.audio_status` lifecycle as a
 * `@ktb/statemachine` declaration, replacing the hand-synced status
 * vocabulary + retry set the audio pipeline used to carry as literals.
 *
 * States (the `audio_status` column):
 *
 *   none ──attach──▶ stored ──enqueue──▶ queued ──begin──▶ processing ──complete──▶ done
 *     │               │  ▲                │  ▲             │
 *     │               │  └──retry─────────┘  │             ├──fail──▶ failed ──retry──▶ queued
 *     │               └──markZk──▶ zk        └──fail──▶ failed ▲
 *     └──fail──▶ failed                                          │
 *                                                             (terminal for the job;
 *                                                              attach still resets it)
 *
 * Event → write mapping (audio-jobs.ts):
 * - `attach`   — attachAudioRecord: a new recording landed (stored).
 *   Allowed from EVERY state including zk — a zk tenant re-uploading
 *   ciphertext still passes through "stored" before the route flips
 *   it back to "zk" (the upload route calls attach, then the zk gate),
 *   and a re-upload while a job is in flight resets the row exactly
 *   like the unconditional UPDATE did before the machine existed.
 * - `enqueue`  — markAudioQueued / owner "queued" mark after the job
 *   was enqueued. `stored` only: re-marking an already-queued row is
 *   a harmless no-op under the conditional write.
 * - `markZk`   — owner "zk" mark (T-147 ciphertext, no server
 *   pipeline). `stored` only, same reasoning.
 * - `begin`    — consumer picked the job up (processing). Sources
 *   include `stored` (enqueue marker write lost but the message
 *   arrived) and `failed` (a redelivered job revives a permanently
 *   failed row — the pre-machine behavior) plus `processing` itself
 *   (idempotent double-delivery).
 * - `complete` — transcript persisted (done). `processing` only: the
 *   row must have been begun by this job lineage.
 * - `fail`     — permanent pipeline failure (failed + audioError).
 *   Every non-`done` state: the consumer fails rows it never began
 *   (missing object, owner mismatch, unconfigured pipeline) and a
 *   `done` row is always skipped before any failure path.
 * - `retry`    — admin requeue (queued). `stored` (enqueue never
 *   landed) + `failed` (terminal pipeline state) — this pair IS
 *   {@link AUDIO_RETRY_STATUSES}, derived below, not hand-listed.
 *
 * Enforcement note: the lifecycle writes in audio-jobs.ts stay
 * single-statement UPDATEs (they were unconditional before; making
 * them conditional on `edges()` sources is a follow-up — the machine
 * is the declared contract new code checks against via `can`/`step`,
 * and the retry set is already derived from it). `done`/`zk` are
 * `terminal` for job purposes — `attach` remains their only way back
 * to work.
 */
export const consultationAudioMachine = defineStateMachine({
	id: "consultations.audio",
	initial: "none",
	states: {
		none: { on: { attach: "stored", fail: "failed" } },
		stored: {
			on: {
				attach: "stored",
				enqueue: "queued",
				markZk: "zk",
				begin: "processing",
				retry: "queued",
				fail: "failed",
			},
		},
		queued: {
			on: {
				attach: "stored",
				begin: "processing",
				fail: "failed",
			},
		},
		zk: { on: { attach: "stored", fail: "failed" } },
		processing: {
			on: {
				attach: "stored",
				begin: "processing",
				complete: "done",
				fail: "failed",
			},
		},
		done: { on: { attach: "stored" } },
		failed: { on: { attach: "stored", begin: "processing", retry: "queued", fail: "failed" } },
	},
	terminal: ["done", "zk"],
});

/** The `audio_status` column vocabulary — every value the machine
 * declares, in declaration order. */
export type ConsultationAudioStatus = (typeof consultationAudioMachine.states)[number];

/** The lifecycle events audio-jobs.ts writes map onto. */
export type ConsultationAudioEvent =
	| "attach"
	| "enqueue"
	| "markZk"
	| "begin"
	| "complete"
	| "fail"
	| "retry";

/** `audioStatus` values an admin retry may re-queue — DERIVED from
 * the machine (`retry → queued` sources) so the set can never drift
 * from the declared lifecycle. "queued"/"processing" may have a live
 * delivery in flight, "done" is terminal-success, "none"/"zk" never
 * had a server job. */
export const AUDIO_RETRY_SOURCES: readonly ConsultationAudioStatus[] =
	consultationAudioMachine.predecessors("retry", "queued");
