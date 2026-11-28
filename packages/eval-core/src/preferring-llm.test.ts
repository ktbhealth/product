import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { EditList, RunRecord } from "./schema.ts";
import {
	LlmPort,
	PlatformLlm,
	PortError,
	preferringLlmPort,
	preferringLlmPortLive,
} from "./index.ts";
import type { TaskEnvelope } from "./ports.ts";

const ENVELOPE: TaskEnvelope = {
	taskId: "t1",
	role: "generator",
	input: "hello",
	outputSchema: "Text",
};

const RECORD = (engine: string): RunRecord =>
	({
		runId: "r",
		taskId: "t1",
		stage: "generate",
		engine,
		inputHash: "h",
		startedAt: 0,
	}) as RunRecord;

const llmLayer = (generate: (input: string) => { text: string } | Error, engine = "stub-engine") =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			generate: (envelope) => {
				const out = generate(envelope.input);
				return out instanceof Error
					? Effect.fail(new PortError({ port: "l", message: out.message }))
					: Effect.succeed({ text: out.text, record: RECORD(engine) });
			},
			correct: () => Effect.fail(new PortError({ port: "l", message: "no correct" })),
		}),
	);

/** Port that dies (defect) instead of failing — exercises the
 * catchDefect degradation arms, which typed failures never reach. */
const dyingLlmLayer = Layer.succeed(
	LlmPort,
	LlmPort.of({
		generate: () => Effect.die(new Error("boom")),
		correct: () => Effect.die(new Error("boom")),
	}),
);

const fallbackService = LlmPort.of({
	egress: false,
	generate: () => Effect.succeed({ text: "env", record: RECORD("env-engine") }),
	correct: () =>
		Effect.succeed({
			edits: { ops: [] } as EditList,
			record: RECORD("env-engine"),
		}),
});

const platformService = (layer: Layer.Layer<LlmPort> | null | "fail" | "die") =>
	PlatformLlm.of({
		defaultLayer: (): Effect.Effect<Layer.Layer<LlmPort> | null, never, unknown> =>
			layer === "fail"
				? (Effect.fail(new Error("db gone")) as never)
				: layer === "die"
					? (Effect.die(new Error("db defect")) as never)
					: Effect.succeed(layer),
	});

const runGenerate = (
	service: LlmPort["Service"],
	platform?: PlatformLlm["Service"],
): Promise<{ text: string; record: RunRecord }> => {
	const effect = Effect.gen(function* () {
		const llm = yield* LlmPort;
		return yield* llm.generate(ENVELOPE);
	}).pipe(Effect.provideService(LlmPort, service));
	const provided =
		platform === undefined ? effect : effect.pipe(Effect.provideService(PlatformLlm, platform));
	return Effect.runPromise(provided);
};

const CORRECT_ENVELOPE: TaskEnvelope = {
	...ENVELOPE,
	role: "corrector",
	outputSchema: "EditList",
};

const runCorrect = (
	service: LlmPort["Service"],
	platform?: PlatformLlm["Service"],
): Promise<{ edits: EditList; record: RunRecord }> => {
	const effect = Effect.gen(function* () {
		const llm = yield* LlmPort;
		return yield* llm.correct(CORRECT_ENVELOPE);
	}).pipe(Effect.provideService(LlmPort, service));
	const provided =
		platform === undefined ? effect : effect.pipe(Effect.provideService(PlatformLlm, platform));
	return Effect.runPromise(provided);
};

describe("preferringLlmPort", () => {
	it("generates through the platform default endpoint and tags the record", async () => {
		const res = await runGenerate(
			preferringLlmPort(fallbackService),
			platformService(llmLayer(() => ({ text: "platform" }), "acp")),
		);
		expect(res.text).toBe("platform");
		expect(res.record.engine).toBe("platform:acp");
	});

	it("falls back to the inner port when the platform path fails", async () => {
		// Endpoint down.
		expect(
			(
				await runGenerate(
					preferringLlmPort(fallbackService),
					platformService(llmLayer(() => new Error("down"))),
				)
			).record.engine,
		).toBe("env-engine");
		// Port bound but no default configured.
		expect(
			(await runGenerate(preferringLlmPort(fallbackService), platformService(null))).record.engine,
		).toBe("env-engine");
		// defaultLayer itself fails typed or defects — both degrade.
		expect(
			(await runGenerate(preferringLlmPort(fallbackService), platformService("fail"))).record
				.engine,
		).toBe("env-engine");
		expect(
			(await runGenerate(preferringLlmPort(fallbackService), platformService("die"))).record.engine,
		).toBe("env-engine");
		// Defects on the platform path degrade the same way.
		expect(
			(await runGenerate(preferringLlmPort(fallbackService), platformService(dyingLlmLayer))).record
				.engine,
		).toBe("env-engine");
	});

	it("uses the fallback when the port is unbound", async () => {
		const res = await runGenerate(preferringLlmPort(fallbackService));
		expect(res.record.engine).toBe("env-engine");
	});

	it("routes correct() through the same precedence", async () => {
		const correctLayer = Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.die("unused"),
				correct: () =>
					Effect.succeed({
						edits: { ops: [] } as EditList,
						record: RECORD("platform-corrector"),
					}),
			}),
		);
		const res = await Effect.runPromise(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.correct({ ...ENVELOPE, role: "corrector", outputSchema: "EditList" });
			}).pipe(
				Effect.provideService(LlmPort, preferringLlmPort(fallbackService)),
				Effect.provideService(PlatformLlm, platformService(correctLayer)),
			),
		);
		expect(res.record.engine).toBe("platform:platform-corrector");
	});

	it("routes correct() to the inner port when the platform path cannot serve", async () => {
		// PlatformLlm bound but no default configured.
		expect(
			(await runCorrect(preferringLlmPort(fallbackService), platformService(null))).record.engine,
		).toBe("env-engine");
		// Port unbound entirely.
		expect((await runCorrect(preferringLlmPort(fallbackService))).record.engine).toBe("env-engine");
		// Platform endpoint's correct() fails — degrades to fallback.
		const failingCorrector = Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.die("unused"),
				correct: () => Effect.fail(new PortError({ port: "l", message: "down" })),
			}),
		);
		expect(
			(await runCorrect(preferringLlmPort(fallbackService), platformService(failingCorrector)))
				.record.engine,
		).toBe("env-engine");
	});
});

describe("preferringLlmPortLive", () => {
	it("binds LlmPort over the fallback layer", async () => {
		const res = await Effect.runPromise(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.generate(ENVELOPE);
			}).pipe(Effect.provide(preferringLlmPortLive(llmLayer(() => ({ text: "x" }), "env")))),
		);
		expect(res.record.engine).toBe("env");
	});

	it("without a fallback, an unbound PlatformLlm fails honestly", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.generate(ENVELOPE);
			}).pipe(Effect.provide(preferringLlmPortLive())),
		);
		expect(exit._tag).toBe("Failure");
	});

	it("without a fallback, correct() fails honestly too", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.correct(CORRECT_ENVELOPE);
			}).pipe(Effect.provide(preferringLlmPortLive())),
		);
		expect(exit._tag).toBe("Failure");
	});
});
