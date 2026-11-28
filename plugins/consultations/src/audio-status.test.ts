import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { TransitionResult } from "@ktb/statemachine";

import { AUDIO_RETRY_STATUSES } from "./api.ts";
import {
	consultationAudioMachine,
	AUDIO_RETRY_SOURCES,
	type ConsultationAudioEvent,
	type ConsultationAudioStatus,
} from "./audio-status.ts";

/**
 * The audio lifecycle machine is the declared contract behind
 * `consultations.audio_status` — these tests pin the properties the
 * pipeline relies on (retry set, terminal states, job reachability)
 * so a spec edit that breaks them fails loudly here.
 */
describe("consultationAudioMachine", () => {
	it("covers the full audio_status vocabulary", () => {
		expect(consultationAudioMachine.states).toEqual([
			"none",
			"stored",
			"queued",
			"zk",
			"processing",
			"done",
			"failed",
		]);
	});

	it("derives the admin retry set from retry→queued sources", () => {
		expect(AUDIO_RETRY_SOURCES).toEqual(["stored", "failed"]);
		expect(AUDIO_RETRY_STATUSES).toEqual(["stored", "failed"]);
	});

	it("never lets a live-delivery state be retried", () => {
		for (const busy of ["queued", "processing", "done", "none", "zk"] as const) {
			expect(consultationAudioMachine.can(busy, "retry")).toBe(false);
		}
	});

	it("models the happy path stored → queued → processing → done", async () => {
		const path = [
			["stored", "enqueue"],
			["queued", "begin"],
			["processing", "complete"],
		] as const;
		let state: ConsultationAudioStatus = "stored";
		for (const [from, event] of path) {
			expect(state).toBe(from);
			// Explicit annotation breaks the state↔result inference cycle.
			const result: TransitionResult<ConsultationAudioStatus, ConsultationAudioEvent> =
				await Effect.runPromise(consultationAudioMachine.step(state, event));
			state = result.to;
		}
		expect(state).toBe("done");
		expect(consultationAudioMachine.isTerminal("done")).toBe(true);
	});

	it("keeps done unreachable for job events — only attach resets it", () => {
		for (const event of ["enqueue", "markZk", "begin", "complete", "fail", "retry"] as const) {
			expect(consultationAudioMachine.can("done", event)).toBe(false);
		}
		expect(consultationAudioMachine.can("done", "attach")).toBe(true);
	});

	it("lets every state fail except done (consumer fail paths precede begin)", () => {
		for (const state of consultationAudioMachine.states) {
			expect(consultationAudioMachine.can(state, "fail")).toBe(state !== "done");
		}
	});
});
