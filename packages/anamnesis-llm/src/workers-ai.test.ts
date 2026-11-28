import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_WORKERS_AI_MODEL,
	responseText,
	runChat,
	type WorkersAiBinding,
} from "./workers-ai.ts";

const fakeAi = (run: WorkersAiBinding["run"]): WorkersAiBinding => ({ run });

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

	it("omits the system message when system is empty", async () => {
		const run = vi.fn(async () => "out");
		await Effect.runPromise(runChat(fakeAi(run), "m", "", "usr"));
		expect(run).toHaveBeenCalledWith("m", {
			messages: [{ role: "user", content: "usr" }],
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
