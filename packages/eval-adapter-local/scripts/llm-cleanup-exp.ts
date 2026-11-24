#!/usr/bin/env bun
/**
 * llm-cleanup-exp — T-164 follow-up EXPERIMENT (not pipeline code).
 *
 * Question: does an LLM cleanup pass reduce WER on the real
 * faster-whisper output of consult-ptbr-real — and do ASR segment
 * TIMESTAMPS ([m:ss] per whisper segment) help the corrector?
 *
 * Variants per sample (gold = authored script, hyp = candidate):
 *   baseline  — wer(gold, asrText)                       (no LLM)
 *   plain     — LLM rewrite of the raw ASR text         (generate)
 *   ts        — same, but input carries [m:ss] segment  (generate)
 *               timestamps from a fresh /transcribe call
 *   corrector — production path: LlmPort.correct → EditList →
 *               applyEdits. NOTE: the ACP adapter sends
 *               envelope.input VERBATIM as the prompt — no
 *               corrector instructions are wrapped, so this
 *               variant documents what the pipeline actually
 *               gets today (expected: EditList parse failure).
 *
 *   bun packages/eval-adapter-local/scripts/llm-cleanup-exp.ts \
 *     --workdir /home/luis/tmp/eval-ptbr-real [--limit N] \
 *     [--agent "devin acp"] [--asr-url http://127.0.0.1:8765]
 *
 * Model-agnostic: --agent takes any ACP-speaking CLI argv
 * (devin acp, claude-agent-acp, …). Requires the workdir to hold a
 * completed `local-asr` eval run (results table) + the asr-server
 * for the timestamp variant.
 */

import Database from "better-sqlite3";
import * as path from "node:path";

import * as Effect from "effect/Effect";

import { makeNodeAcpLlm } from "@ktb/ai-adapter-node";
import { applyEdits } from "@ktb/eval-core";
import { LlmPort, wer } from "@ktb/eval-consultation";

// ---------- args ----------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};

const workdir = path.resolve(flag("workdir") ?? "/home/luis/tmp/eval-ptbr-real");
const asrUrl = flag("asr-url") ?? "http://127.0.0.1:8765";
const agentCmd = flag("agent") ?? "devin acp";
const limitRaw = flag("limit");
const limitParsed = limitRaw === undefined ? NaN : Number.parseInt(limitRaw, 10);
const limit = Number.isFinite(limitParsed) ? limitParsed : undefined;

// ---------- store ----------

const db = new Database(path.join(workdir, "manifest.sqlite"));
const runId = (
	db.prepare(`SELECT run_id FROM results ORDER BY rowid DESC LIMIT 1`).get() as {
		run_id: string;
	}
).run_id;
const rows = db
	.prepare(
		`SELECT s.doc AS sdoc, r.doc AS rdoc FROM results r JOIN samples s ON s.id = r.sample_id WHERE r.run_id = ? ORDER BY r.sample_id`,
	)
	.all(runId) as { sdoc: string; rdoc: string }[];
const cohort = rows
	.map((r) => ({
		sample: JSON.parse(r.sdoc) as {
			id: string;
			script: string;
			audio?: { uri?: string };
		},
		result: JSON.parse(r.rdoc) as { asrText?: string },
	}))
	.filter((c) => typeof c.result.asrText === "string")
	.slice(0, limit);
console.log(`run ${runId}: ${cohort.length} samples`);

// ---------- helpers ----------

const mmss = (sec: number): string => {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
};

interface AsrSegment {
	readonly t0: number;
	readonly t1: number;
	readonly text: string;
	readonly confidence?: number;
}

const transcribe = async (audioUri: string | undefined): Promise<readonly AsrSegment[]> => {
	if (audioUri === undefined || !audioUri.startsWith("file://")) return [];
	const res = await fetch(`${asrUrl}/transcribe`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			audio_path: audioUri.slice("file://".length),
			language: "pt",
		}),
	});
	if (!res.ok) throw new Error(`asr ${res.status}: ${await res.text()}`);
	const body = (await res.json()) as { segments?: AsrSegment[] };
	return body.segments ?? [];
};

const INSTR = `Você é um corretor de transcrições de consultas médicas em português brasileiro. A entrada é a saída bruta de um reconhecedor de fala (ASR).

Corrija APENAS erros de transcrição: ortografia, acentuação, nomes de medicamentos e termos clínicos, números ditados, pontuação. NÃO adicione informação que não esteja no áudio, NÃO remova a fala original, NÃO resuma, NÃO comente. Responda SOMENTE com o texto corrigido em um único parágrafo corrido.`;

const tsText = (segs: readonly AsrSegment[]): string =>
	segs.map((s) => `[${mmss(s.t0)}] ${s.text.trim()}`).join("\n");

// ---------- run ----------

const llmLayer = makeNodeAcpLlm({
	argv: agentCmd.trim().split(/\s+/),
	cwd: workdir,
	timeoutMs: 180_000,
});

const results: {
	id: string;
	baseline: number;
	plain?: number;
	ts?: number;
	corrector?: number;
	errors: string[];
}[] = [];

const program = Effect.forEach(
	cohort,
	(c) =>
		Effect.gen(function* () {
			const llm = yield* LlmPort;
			const out = {
				id: c.sample.id,
				baseline: wer(c.sample.script, c.result.asrText!),
				errors: [] as string[],
			} as (typeof results)[number];
			const taskId = `exp-${c.sample.id}`;

			// Variant A — plain rewrite
			const genA = yield* llm
				.generate({
					taskId: `${taskId}-plain`,
					role: "corrector",
					input: `${INSTR}\n\n${c.result.asrText}`,
					outputSchema: "Text",
				})
				.pipe(Effect.result);
			if (genA._tag === "Success") out.plain = wer(c.sample.script, genA.success.text);
			else out.errors.push(`plain: ${String(genA.failure)}`);

			// Variant B — timestamped input (fresh ASR pass for segments)
			const segs = yield* Effect.tryPromise({
				try: () => transcribe(c.sample.audio?.uri),
				catch: (e) => e,
			}).pipe(Effect.result);
			if (segs._tag === "Failure") {
				out.errors.push(`ts-asr: ${String(segs.failure)}`);
			} else if (segs.success.length > 0) {
				const genB = yield* llm
					.generate({
						taskId: `${taskId}-ts`,
						role: "corrector",
						input: `${INSTR}\n\nOs segmentos abaixo têm timestamps [m:ss].\n\n${tsText(segs.success)}`,
						outputSchema: "Text",
					})
					.pipe(Effect.result);
				if (genB._tag === "Success") out.ts = wer(c.sample.script, genB.success.text);
				else out.errors.push(`ts: ${String(genB.failure)}`);
			}

			// Variant C — production correct() path (documents the
			// no-instructions gap: input goes verbatim as the prompt)
			const corr = yield* llm
				.correct({
					taskId: `${taskId}-corr`,
					role: "corrector",
					input: c.result.asrText!,
					outputSchema: "EditList",
				})
				.pipe(Effect.result);
			if (corr._tag === "Success") {
				const corrected = yield* Effect.try({
					try: () => applyEdits(c.result.asrText!, corr.success.edits.ops),
					catch: (e) => e,
				}).pipe(Effect.result);
				if (corrected._tag === "Success") {
					out.corrector = wer(c.sample.script, corrected.success);
				} else {
					out.errors.push(`corrector applyEdits: ${String(corrected.failure)}`);
				}
			} else {
				out.errors.push(`corrector: ${String(corr.failure).slice(0, 160)}`);
			}

			return out;
		}),
	{ concurrency: 1 },
);

const done = await Effect.runPromise(program.pipe(Effect.provide(llmLayer)));
results.push(...done);
db.close();

// ---------- report ----------

const mean = (xs: (number | undefined)[]): string => {
	const v = xs.filter((x): x is number => typeof x === "number");
	return v.length === 0 ? "-" : (v.reduce((a, b) => a + b, 0) / v.length).toFixed(4);
};

console.log("\n=== WER (lower is better) ===");
console.log("sample".padEnd(34), "base", "plain", "ts", "corr");
for (const r of results) {
	console.log(
		r.id.padEnd(34),
		r.baseline.toFixed(3),
		(r.plain ?? NaN).toFixed(3),
		(r.ts ?? NaN).toFixed(3),
		(r.corrector ?? NaN).toFixed(3),
	);
	for (const e of r.errors) console.log(`  ! ${e}`);
}
console.log(
	"\nMEAN".padEnd(34),
	mean(results.map((r) => r.baseline)),
	mean(results.map((r) => r.plain)),
	mean(results.map((r) => r.ts)),
	mean(results.map((r) => r.corrector)),
);
