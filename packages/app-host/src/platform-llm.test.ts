import { describe, expect, it } from "vitest";

import type { Anamnesis, ExtractInput } from "@ktb/anamnesis";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { LlmPort, PlatformLlm } from "@ktb/eval-consultation";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { platformPreferringEngine } from "./platform-llm.ts";

const SECTION = { content: "x", confidence: "alta" as const, evidence: [] };
const ANAMNESIS: Anamnesis = {
	queixa_principal: SECTION,
	hda: SECTION,
	antecedentes: SECTION,
	alergias: SECTION,
	medicamentos_em_uso: SECTION,
	exame_fisico: SECTION,
	hipoteses: SECTION,
	conduta: SECTION,
};
const INPUT: ExtractInput = { transcript: "dor de cabeça há 3 dias" };

const llmLayer = (generate: (input: string) => { text: string } | Error) =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			generate: (envelope) => {
				const out = generate(envelope.input);
				return out instanceof Error
					? Effect.fail({ _tag: "PortError", port: "l", message: out.message } as never)
					: Effect.succeed({ text: out.text, record: { engine: "stub-engine" } as never });
			},
			correct: () => Effect.fail({ _tag: "PortError", port: "l", message: "x" } as never),
		}),
	);

const platformService = (layer: Layer.Layer<LlmPort> | null | "fail" | "die") =>
	PlatformLlm.of({
		defaultLayer: (): Effect.Effect<Layer.Layer<LlmPort> | null, never, unknown> =>
			layer === "fail"
				? (Effect.fail(new Error("db gone")) as never)
				: layer === "die"
					? (Effect.die(new Error("db defect")) as never)
					: Effect.succeed(layer),
	});

/** Port that dies (defect) instead of failing — exercises the
 * catchDefect degradation arms, which typed failures never reach. */
const dyingLlmLayer = Layer.succeed(
	LlmPort,
	LlmPort.of({
		generate: () => Effect.die(new Error("boom")),
		correct: () => Effect.die(new Error("boom")),
	}),
);

const run = <A>(eff: Effect.Effect<A>, service?: PlatformLlm["Service"]) =>
	Effect.runPromise(service === undefined ? eff : Effect.provideService(eff, PlatformLlm, service));

describe("platformPreferringEngine", () => {
	const innerEngine = (engine = "inner") =>
		AnamnesisEngine.of({
			extract: () => Effect.succeed({ anamnesis: ANAMNESIS, engine }),
		});
	const extract = (
		inner: AnamnesisEngine["Service"],
		service?: PlatformLlm["Service"],
	): Promise<{ anamnesis: Anamnesis; engine: string }> =>
		Effect.runPromise(
			service === undefined
				? platformPreferringEngine(inner).extract(INPUT)
				: platformPreferringEngine(inner)
						.extract(INPUT)
						.pipe(Effect.provideService(PlatformLlm, service)),
		);

	it("extracts through the platform default endpoint", async () => {
		const res = await extract(
			innerEngine(),
			platformService(llmLayer(() => ({ text: JSON.stringify(ANAMNESIS) }))),
		);
		expect(res.engine).toBe("platform:stub-engine");
		expect(res.anamnesis.queixa_principal.content).toBe("x");
	});

	it("decodes a fenced JSON payload", async () => {
		const res = await extract(
			innerEngine(),
			platformService(
				llmLayer(() => ({ text: `\`\`\`json\n${JSON.stringify(ANAMNESIS)}\n\`\`\`` })),
			),
		);
		expect(res.engine).toBe("platform:stub-engine");
	});

	it("falls back to the inner engine when the platform path fails", async () => {
		// Endpoint down.
		expect(
			(await extract(innerEngine("env"), platformService(llmLayer(() => new Error("down")))))
				.engine,
		).toBe("env");
		// Unparseable payload — the model ignored the JSON contract.
		expect(
			(await extract(innerEngine("env"), platformService(llmLayer(() => ({ text: "not json" })))))
				.engine,
		).toBe("env");
		// Port bound but no default configured.
		expect((await extract(innerEngine("env"), platformService(null))).engine).toBe("env");
		// defaultLayer itself fails typed or defects — both degrade.
		expect((await extract(innerEngine("env"), platformService("fail"))).engine).toBe("env");
		expect((await extract(innerEngine("env"), platformService("die"))).engine).toBe("env");
		// Defects on the platform path degrade the same way.
		expect((await extract(innerEngine("env"), platformService(dyingLlmLayer))).engine).toBe("env");
	});

	it("falls back to the inner engine when the port is unbound", async () => {
		expect((await extract(innerEngine("heuristic"))).engine).toBe("heuristic");
	});
});
