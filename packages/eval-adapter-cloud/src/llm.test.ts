import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { describe, expect, it } from "vitest";

import { EvalPort, PortError, type EvalQuestion, type TaskEnvelope } from "@ktb/eval-core";
import { LlmPort } from "@ktb/eval-consultation";

import { makeWorkersAiEval, makeWorkersAiLlm, type WorkersAiLlmOptions } from "./llm.ts";

const env: TaskEnvelope = {
	taskId: "t-1",
	role: "generator",
	input: "say hi",
	outputSchema: "Text",
};

const fetchJson = (body: unknown, init?: { status?: number }) =>
	((_url: string, _init?: RequestInit) =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status: init?.status ?? 200,
				headers: { "Content-Type": "application/json" },
			}),
		)) as unknown as typeof fetch;

const opts = (fetchImpl: typeof fetch, over: Partial<WorkersAiLlmOptions> = {}) => ({
	accountId: "acc",
	apiToken: "tok",
	model: "@cf/test-model",
	fetchImpl,
	...over,
});

const withLlm = <A, E>(
	layer: ReturnType<typeof makeWorkersAiLlm>,
	f: (l: typeof LlmPort.Service) => Effect.Effect<A, E>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const l = yield* LlmPort;
			return yield* f(l);
		}).pipe(Effect.provide(layer)),
	);

const withEval = <A, E>(
	layer: ReturnType<typeof makeWorkersAiEval>,
	f: (l: typeof EvalPort.Service) => Effect.Effect<A, E>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const l = yield* EvalPort;
			return yield* f(l);
		}).pipe(Effect.provide(layer)),
	);

describe("makeWorkersAiLlm", () => {
	it("generate returns result.response text and a RunRecord", async () => {
		const r = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: true, result: { response: "ola" } }))),
			(l) => l.generate(env),
		);
		expect(r.text).toBe("ola");
		expect(r.record.stage).toBe("script_gen");
		expect(r.record.engine).toBe("workers-ai:@cf/test-model");
		expect(r.record.model).toBe("@cf/test-model");
	});

	it("generate accepts the chat choices shape", async () => {
		const r = await withLlm(
			makeWorkersAiLlm(
				opts(fetchJson({ success: true, result: { choices: [{ message: { content: "oi" } }] } })),
			),
			(l) => l.generate(env),
		);
		expect(r.text).toBe("oi");
	});

	it("posts a JSON messages body to the run endpoint", async () => {
		let seen: {
			url?: string;
			body?: { messages?: { role?: string }[] };
			auth?: string;
		} = {};
		const spy = ((_url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			seen = {
				url: _url,
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as { messages?: { role?: string }[] })
						: undefined,
				auth: headers?.Authorization,
			};
			return Promise.resolve(
				new Response(JSON.stringify({ success: true, result: { response: "x" } })),
			);
		}) as unknown as typeof fetch;
		await withLlm(makeWorkersAiLlm(opts(spy)), (l) => l.generate(env));
		expect(seen.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/test-model",
		);
		expect(seen.auth).toBe("Bearer tok");
		expect(seen.body?.messages?.[0]?.role).toBe("system");
	});

	it("correct decodes an EditList payload (fenced JSON tolerated)", async () => {
		const edits = { ops: [{ at: 0, remove: "a", insert: "b", kind: "fix" }] };
		const r = await withLlm(
			makeWorkersAiLlm(
				opts(
					fetchJson({
						success: true,
						result: { response: "```json\n" + JSON.stringify(edits) + "\n```" },
					}),
				),
			),
			(l) => l.correct({ ...env, role: "corrector", outputSchema: "EditList" }),
		);
		expect(r.edits.ops).toHaveLength(1);
		expect(r.edits.ops[0]?.kind).toBe("fix");
		expect(r.record.stage).toBe("cleanup");
	});

	it("correct rejects a non-EditList envelope without calling fetch", async () => {
		let called = false;
		const spy = (() => {
			called = true;
			return Promise.resolve(new Response("{}"));
		}) as unknown as typeof fetch;
		const err = await withLlm(makeWorkersAiLlm(opts(spy)), (l) => l.correct(env)).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("outputSchema=EditList");
		expect(called).toBe(false);
	});

	it("correct fails typed on malformed edit JSON", async () => {
		const err = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: true, result: { response: "not json" } }))),
			(l) => l.correct({ ...env, role: "corrector", outputSchema: "EditList" }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).port).toBe("llm");
	});

	it("surfaces provider success=false detail", async () => {
		const err = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: false, errors: ["rate limited"] }))),
			(l) => l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("rate limited");
	});

	it("maps HTTP failures to PortError", async () => {
		const err = await withLlm(makeWorkersAiLlm(opts(fetchJson({}, { status: 500 }))), (l) =>
			l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("500");
	});

	it("fails typed on a malformed envelope", async () => {
		const err = await withLlm(makeWorkersAiLlm(opts(fetchJson({ unexpected: true }))), (l) =>
			l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("malformed response");
	});

	it("fails typed when success=true carries no result", async () => {
		const err = await withLlm(makeWorkersAiLlm(opts(fetchJson({ success: true }))), (l) =>
			l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("success=true without result");
	});

	it("fails typed on empty choices", async () => {
		const err = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: true, result: { choices: [] } }))),
			(l) => l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("empty choices");
	});

	it("surfaces provider messages detail on success=false", async () => {
		const err = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: false, messages: ["denied by policy"] }))),
			(l) => l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("denied by policy");
	});

	it("serializes non-string provider errors", async () => {
		const err = await withLlm(
			makeWorkersAiLlm(opts(fetchJson({ success: false, errors: [{ code: "E1" }] }))),
			(l) => l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain('"code":"E1"');
	});

	it("reports bare success=false without detail", async () => {
		const err = await withLlm(makeWorkersAiLlm(opts(fetchJson({ success: false }))), (l) =>
			l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toBe("workers-ai returned success=false");
	});

	it("fails typed on timeout", async () => {
		const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const err = await withLlm(makeWorkersAiLlm(opts(hanging, { timeoutMs: 10 })), (l) =>
			l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("timeout after 10ms");
	});

	it("retries when a schedule is provided", async () => {
		let calls = 0;
		const flaky = (() => {
			calls += 1;
			return calls < 2
				? Promise.resolve(new Response("boom", { status: 500 }))
				: Promise.resolve(
						new Response(JSON.stringify({ success: true, result: { response: "ok" } })),
					);
		}) as unknown as typeof fetch;
		const r = await withLlm(makeWorkersAiLlm(opts(flaky, { retry: Schedule.recurs(2) })), (l) =>
			l.generate(env),
		);
		expect(calls).toBe(2);
		expect(r.text).toBe("ok");
	});

	it("defaults to the global fetch when fetchImpl is absent", async () => {
		// Point at an unroutable local endpoint — real fetch fails fast.
		const err = await withLlm(
			makeWorkersAiLlm({
				accountId: "a",
				apiToken: "t",
				model: "m",
				endpoint: "http://localhost:1",
			}),
			(l) => l.generate(env),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toMatch(/fetch failed|ECONNREFUSED|network/i);
	});

	it("maps non-Error fetch throws to PortError", async () => {
		const throwing = (() => Promise.reject("net down")) as unknown as typeof fetch;
		const err = await withLlm(makeWorkersAiLlm(opts(throwing)), (l) => l.generate(env)).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("net down");
	});

	it("correct tolerates prose around the JSON payload", async () => {
		const edits = { ops: [{ at: 0, remove: "a", insert: "b", kind: "fix" }] };
		const r = await withLlm(
			makeWorkersAiLlm(
				opts(
					fetchJson({
						success: true,
						result: {
							response: `Here you go: ${JSON.stringify(edits)} — done`,
						},
					}),
				),
			),
			(l) => l.correct({ ...env, role: "corrector", outputSchema: "EditList" }),
		);
		expect(r.edits.ops).toHaveLength(1);
	});
});

describe("makeWorkersAiEval", () => {
	const questions: EvalQuestion[] = [
		{ id: "q1", kind: "noul", text: "is it fluent?" },
		{ id: "q2", kind: "choice", text: "severity?", options: ["low", "high"] },
		{ id: "q3", kind: "score", text: "quality?", maxScore: 3 },
	];

	const verdicts = [
		{ id: "q1", value: true, probability: 0.9 },
		{ id: "q2", value: "low", probability: 0.8 },
		{ id: "q3", value: 2, probability: 0.7 },
	];

	it("judge returns typed answers for every question", async () => {
		const r = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: JSON.stringify(verdicts) } })),
			),
			(l) => l.judge({ state: { text: "ola" }, questions }),
		);
		expect(r.answers).toHaveLength(3);
		expect(r.answers[0]).toEqual({ id: "q1", kind: "noul", value: true, probability: 0.9 });
		expect(r.answers[2]?.value).toBe(2);
		expect(r.record.stage).toBe("judge");
	});

	it("empty question list short-circuits without fetch", async () => {
		let called = false;
		const spy = (() => {
			called = true;
			return Promise.resolve(new Response("{}"));
		}) as unknown as typeof fetch;
		const r = await withEval(makeWorkersAiEval(opts(spy)), (l) =>
			l.judge({ state: {}, questions: [] }),
		);
		expect(r.answers).toEqual([]);
		expect(called).toBe(false);
	});

	it("fails typed when a question has no answer", async () => {
		const err = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: JSON.stringify([verdicts[0]]) } })),
			),
			(l) => l.judge({ state: {}, questions }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain('no answer for question "q2"');
	});

	it("fails typed on out-of-range probability", async () => {
		const bad = [{ id: "q1", value: true, probability: 1.5 }];
		const err = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: JSON.stringify(bad) } })),
			),
			(l) => l.judge({ state: {}, questions: [questions[0]!] }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain("outside [0,1]");
	});

	it("fails typed when a choice value is not among options", async () => {
		const bad = [{ id: "q2", value: "medium", probability: 0.5 }];
		const err = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: JSON.stringify(bad) } })),
			),
			(l) => l.judge({ state: {}, questions: [questions[1]!] }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).port).toBe("eval");
	});

	it("fails typed on malformed judge JSON", async () => {
		const err = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: "I cannot answer" } })),
			),
			(l) => l.judge({ state: {}, questions }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
	});

	it("accepts a score question without maxScore", async () => {
		const r = await withEval(
			makeWorkersAiEval(
				opts(
					fetchJson({
						success: true,
						result: {
							response: JSON.stringify([{ id: "s", value: 1, probability: 0.5 }]),
						},
					}),
				),
			),
			(l) => l.judge({ state: {}, questions: [{ id: "s", kind: "score", text: "q?" }] }),
		);
		expect(r.answers[0]).toEqual({ id: "s", kind: "score", value: 1, probability: 0.5 });
	});

	it("fails typed on duplicate judge answer ids", async () => {
		const dup = [verdicts[0], verdicts[0]];
		const err = await withEval(
			makeWorkersAiEval(
				opts(fetchJson({ success: true, result: { response: JSON.stringify(dup) } })),
			),
			(l) => l.judge({ state: {}, questions: [questions[0]!] }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as PortError).message).toContain('duplicate judge answer for question "q1"');
	});

	it("maps transport failures to the eval port", async () => {
		const err = await withEval(makeWorkersAiEval(opts(fetchJson({}, { status: 500 }))), (l) =>
			l.judge({ state: {}, questions }),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).port).toBe("eval");
	});
});
