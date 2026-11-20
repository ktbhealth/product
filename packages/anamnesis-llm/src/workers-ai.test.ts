import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vitest";

import type { Anamnesis } from "@ktb/anamnesis";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import {
	DEFAULT_WORKERS_AI_MODEL,
	makeWorkersAiAnamnesisEngine,
	responseText,
	runChat,
	type WorkersAiBinding,
} from "./workers-ai.ts";

const section = (content: string) => ({
	content,
	confidence: "alta" as const,
	evidence: ["evidência"],
});

const MOCK_ANAMNESIS: Anamnesis = {
	queixa_principal: section("Dor de cabeça"),
	hda: section("Há 3 dias"),
	antecedentes: section("Nega"),
	alergias: section("Nega"),
	medicamentos_em_uso: section("Nega"),
	exame_fisico: section("N/A"),
	hipoteses: section("Enxaqueca"),
	conduta: section("Dipirona"),
};

const fakeAi = (run: WorkersAiBinding["run"]): WorkersAiBinding => ({ run });

const jsonResponse = (value: unknown) => ({ response: JSON.stringify(value) });

/** Captures log entries emitted through Effect.log* inside the effect. */
const captureLogs = () => {
	const entries: { message: unknown; annotations: Record<string, unknown> }[] = [];
	const logger = Logger.make((options) => {
		const message: unknown = options.message;
		entries.push({
			message,
			annotations: Array.isArray(message)
				? ((message[1] as Record<string, unknown> | undefined) ?? {})
				: {},
		});
	});
	return { entries, logger };
};

/** Records every span opened while the effect runs. */
const makeTracer = () => {
	const spans: Tracer.NativeSpan[] = [];
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			spans.push(span);
			return span;
		},
	});
	return { spans, tracer };
};

describe("workers-ai anamnesis engine", () => {
	it("extracts JSON from a {response} payload", async () => {
		const run = vi.fn(async () => jsonResponse(MOCK_ANAMNESIS));
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(makeWorkersAiAnamnesisEngine(fakeAi(run), "m1"))),
		);
		const { spans, tracer } = makeTracer();
		const res = await Effect.runPromise(
			engine
				.extract({ transcript: "paciente com dor" })
				.pipe(Effect.provideService(Tracer.Tracer, tracer)),
		);
		expect(res.engine).toBe("workers-ai:m1");
		expect(res.anamnesis.queixa_principal.content).toBe("Dor de cabeça");
		expect(spans.map((s) => s.name)).toContain("AnamnesisEngine.extract");
		expect(run).toHaveBeenCalledWith(
			"m1",
			expect.objectContaining({ messages: expect.any(Array) }),
		);
	});

	it("handles string and {result} response shapes and fenced JSON", async () => {
		for (const raw of [
			JSON.stringify(MOCK_ANAMNESIS),
			{ result: `\`\`\`json\n${JSON.stringify(MOCK_ANAMNESIS)}\n\`\`\`` },
			{ response: { response: JSON.stringify(MOCK_ANAMNESIS) } },
		]) {
			const engine = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* AnamnesisEngine;
				}).pipe(
					Effect.provide(
						makeWorkersAiAnamnesisEngine(
							fakeAi(async () => raw),
							"m",
						),
					),
				),
			);
			const res = await Effect.runPromise(engine.extract({ transcript: "t" }));
			expect(res.engine).toBe("workers-ai:m");
		}
	});

	it("extracts JSON wrapped in leading prose", async () => {
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(
				Effect.provide(
					makeWorkersAiAnamnesisEngine(
						fakeAi(async () => ({ response: `x${JSON.stringify(MOCK_ANAMNESIS)}` })),
						"m",
					),
				),
			),
		);
		const res = await Effect.runPromise(engine.extract({ transcript: "t" }));
		expect(res.engine).toBe("workers-ai:m");
		expect(res.anamnesis.queixa_principal.content).toBe("Dor de cabeça");
	});

	it("passes patient history in the system prompt and stores historico", async () => {
		const run = vi.fn(async (_m: string, inputs: unknown) => {
			const msgs = (inputs as { messages: { content: string }[] }).messages;
			expect(msgs[0]?.content).toContain("PATIENT HISTORY");
			return jsonResponse(MOCK_ANAMNESIS);
		});
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(makeWorkersAiAnamnesisEngine(fakeAi(run), "m1"))),
		);
		const res = await Effect.runPromise(
			engine.extract({
				transcript: "retorno",
				history: {
					count: 1,
					visits: [
						{
							id: 5,
							date: "2026-03-01T10:00:00.000Z",
							chiefComplaint: "Dor",
							plan: "Repouso",
						},
					],
				},
			}),
		);
		expect(res.anamnesis.historico?.content).toContain("Consultas anteriores (1):");
	});

	it("falls back to heuristic on run failure, bad JSON, or schema mismatch", async () => {
		for (const run of [
			vi.fn(async () => {
				throw new Error("ai down");
			}),
			vi.fn(async () => ({ response: "no json here" })),
			vi.fn(async () => jsonResponse({ wrong: true })),
			vi.fn(async () => ({})),
			vi.fn(async () => ({ response: { response: 42 } })),
			vi.fn(async () => 42),
		]) {
			const engine = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* AnamnesisEngine;
				}).pipe(Effect.provide(makeWorkersAiAnamnesisEngine(fakeAi(run), "m"))),
			);
			const res = await Effect.runPromise(engine.extract({ transcript: "paciente relata tosse" }));
			expect(res.engine).toBe("workers-ai:m!fallback");
			expect(res.anamnesis.queixa_principal.content).toBeTruthy();
		}
	});

	it("logs the fallback reason with the engine tag", async () => {
		const { entries, logger } = captureLogs();
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(
				Effect.provide(
					makeWorkersAiAnamnesisEngine(
						fakeAi(async () => ({ response: "no json here" })),
						"m",
					),
				),
			),
		);
		const res = await Effect.runPromise(
			engine
				.extract({ transcript: "paciente relata tosse" })
				.pipe(Effect.provide(Logger.layer([logger]))),
		);
		expect(res.engine).toBe("workers-ai:m!fallback");
		const warn = entries.find((e) => String(e.message).includes("workers-ai extraction failed"));
		expect(warn?.annotations.engine).toBe("workers-ai:m");
		expect(String(warn?.annotations.error)).toContain("no JSON object in model output");
	});

	it("reports 'no JSON object' for outputs whose braces cannot form an object", async () => {
		for (const text of ["no json here", "a}1", "{", "}"]) {
			const { entries, logger } = captureLogs();
			const engine = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* AnamnesisEngine;
				}).pipe(
					Effect.provide(
						makeWorkersAiAnamnesisEngine(
							fakeAi(async () => text),
							"m",
						),
					),
				),
			);
			await Effect.runPromise(
				engine.extract({ transcript: "t" }).pipe(Effect.provide(Logger.layer([logger]))),
			);
			const warn = entries.find((e) => String(e.message).includes("workers-ai extraction failed"));
			expect(String(warn?.annotations.error)).toContain("no JSON object in model output");
		}
	});
});

describe("responseText", () => {
	it("extracts text from every supported response shape", () => {
		expect(responseText("hi")).toBe("hi");
		expect(responseText({ response: "a" })).toBe("a");
		expect(responseText({ result: "b" })).toBe("b");
		expect(responseText({ response: { response: "c" } })).toBe("c");
	});

	it("rejects unsupported shapes with a descriptive error", () => {
		for (const raw of [
			null,
			undefined,
			42,
			true,
			{},
			{ response: 42 },
			{ response: null },
			{ result: 1 },
			{ response: { response: 42 } },
		]) {
			expect(() => responseText(raw)).toThrow("unrecognized response shape");
		}
	});
});

describe("runChat", () => {
	it("posts the chat envelope and returns the response text", async () => {
		const run = vi.fn(async () => ({ response: "  out  " }));
		const ai = fakeAi(run);
		await expect(Effect.runPromise(runChat(ai, "m", "sys", "usr"))).resolves.toBe("  out  ");
		expect(run).toHaveBeenCalledWith("m", {
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "usr" },
			],
			max_tokens: 4096,
		});
	});

	it("propagates the binding error unchanged", async () => {
		const boom = new Error("ai down");
		const ai = fakeAi(async () => {
			throw boom;
		});
		await expect(Effect.runPromise(Effect.flip(runChat(ai, "m", "s", "u")))).resolves.toBe(boom);
	});

	it("surfaces response-shape errors instead of swallowing them", async () => {
		const ai = fakeAi(async () => ({}));
		const error = await Effect.runPromise(Effect.flip(runChat(ai, "m", "s", "u")));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("unrecognized response shape");
	});

	it("emits an ai.workers-ai span tagged with the model", async () => {
		const { spans, tracer } = makeTracer();
		await Effect.runPromise(
			runChat(
				fakeAi(async () => "x"),
				"model-x",
				"s",
				"u",
			).pipe(Effect.provideService(Tracer.Tracer, tracer)),
		);
		const span = spans.find((s) => s.name === "ai.workers-ai");
		expect(span?.attributes.get("ai.model")).toBe("model-x");
	});
});

describe("workers-ai config surface", () => {
	it("default model constant is a workers-ai model id", () => {
		expect(DEFAULT_WORKERS_AI_MODEL).toMatch(/^@cf\//);
	});
});
