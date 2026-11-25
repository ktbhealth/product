import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { CleanupGate, fnvHex } from "@ktb/eval-consultation";

import { makeScoresFileCleanupGate, makeSystemOneCleanupGate } from "./gate.ts";

const select = (
	layer: ReturnType<typeof makeScoresFileCleanupGate>,
	input: { sampleId: string; text: string; segments: readonly { text: string }[] },
) =>
	Effect.gen(function* () {
		const gate = yield* CleanupGate;
		return { name: gate.name, out: yield* gate.select(input) };
	}).pipe(Effect.provide(layer));

/** System One wire stub: answers every noul question with the p
 * keyed to its segment index (`s<i>` → p[i]). */
const systemoneFetch = (p: readonly number[], urls: string[] = []) =>
	(async (url: unknown, init?: { body?: unknown }) => {
		const u = typeof url === "string" ? url : String(url);
		urls.push(u);
		const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
		const answers = Object.fromEntries(
			Object.keys(body.questions).map((id) => [
				id,
				{ type: "noul", noul: p[Number(id.slice(1))] ?? 0 },
			]),
		);
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;

const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `seg ${i}` }));

describe("makeSystemOneCleanupGate", () => {
	it("scores segments through the System One server and returns merged ranges", async () => {
		const urls: string[] = [];
		const p = [0.2, 0.8, 0.7, 0.1, 0.9];
		const r = await Effect.runPromise(
			select(
				makeSystemOneCleanupGate({
					baseUrl: "http://127.0.0.1:8009",
					fetchImpl: systemoneFetch(p, urls),
				}),
				{ sampleId: "s1", text: "x", segments: segs(5) },
			),
		);
		expect(r.name).toBe("systemone");
		expect(urls).toEqual(["http://127.0.0.1:8009/v1/systemone"]);
		expect(r.out.segmentsScored).toBe(5);
		expect(r.out.ranges).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 4 },
		]);
		expect(r.out.records).toHaveLength(1);
	});

	it("honours the threshold and model options", async () => {
		// Exactly-at-threshold flags; the score passes through the
		// adapter's value/probability round-trip unchanged when the
		// verdict is already "yes".
		const p = [0.4, 0.6, 0.2];
		const r = await Effect.runPromise(
			select(
				makeSystemOneCleanupGate({
					baseUrl: "http://127.0.0.1:8009",
					threshold: 0.6,
					batchSize: 2,
					lang: "en",
					model: "wev-x",
					timeoutMs: 5000,
					fetchImpl: systemoneFetch(p),
				}),
				{ sampleId: "s1", text: "x", segments: segs(3) },
			),
		);
		expect(r.out.ranges).toEqual([{ start: 1, end: 1 }]);
	});

	it("builds with every option absent or set — layer construction is eager", () => {
		// Layer.succeed evaluates the option spreads at make-time, so
		// both branches are pinned without a live server.
		expect(makeSystemOneCleanupGate({ baseUrl: "http://127.0.0.1:8009" })).toBeDefined();
		expect(
			makeSystemOneCleanupGate({
				baseUrl: "http://127.0.0.1:8009",
				lang: "en",
				fetchImpl: (() => Promise.reject(new Error("unused"))) as typeof fetch,
			}),
		).toBeDefined();
	});

	it("propagates server failures as PortErrors", async () => {
		const down = (async () => new Response("boom", { status: 500 })) as typeof fetch;
		const exit = await Effect.runPromiseExit(
			select(makeSystemOneCleanupGate({ baseUrl: "http://127.0.0.1:8009", fetchImpl: down }), {
				sampleId: "s1",
				text: "x",
				segments: segs(1),
			}),
		);
		expect(exit._tag).toBe("Failure");
	});
});

describe("makeScoresFileCleanupGate", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scores-"));
	const file = path.join(dir, "scores.json");
	const text = "alpha beta gamma";
	const write = (entries: Record<string, unknown>) =>
		fs.writeFileSync(file, JSON.stringify(entries));

	it("replays ranges from the file at the given threshold", async () => {
		write({ s1: { textHash: fnvHex(text), scores: [0.1, 0.8, 0.6] } });
		const r = await Effect.runPromise(
			select(makeScoresFileCleanupGate({ path: file, threshold: 0.5 }), {
				sampleId: "s1",
				text,
				segments: segs(3),
			}),
		);
		expect(r.name).toBe("scores-file");
		expect(r.out.ranges).toEqual([{ start: 1, end: 2 }]);
		expect(r.out.segmentsScored).toBe(3);
		expect(r.out.records).toEqual([]);
	});

	it("fails honestly on a text-hash mismatch (stale scores)", async () => {
		write({ s1: { textHash: "other", scores: [0.9] } });
		const exit = await Effect.runPromiseExit(
			select(makeScoresFileCleanupGate({ path: file }), {
				sampleId: "s1",
				text,
				segments: segs(1),
			}),
		);
		expect(exit._tag).toBe("Failure");
	});

	it("fails on missing sample, malformed entry and segment-count drift", async () => {
		write({ s1: { textHash: fnvHex(text), scores: [0.9] }, bad: "x" });
		const layer = makeScoresFileCleanupGate({ path: file });
		const missing = await Effect.runPromiseExit(
			select(layer, { sampleId: "nope", text, segments: segs(1) }),
		);
		expect(missing._tag).toBe("Failure");
		const malformed = await Effect.runPromiseExit(
			select(layer, { sampleId: "bad", text, segments: segs(1) }),
		);
		expect(malformed._tag).toBe("Failure");
		const drift = await Effect.runPromiseExit(
			select(layer, { sampleId: "s1", text, segments: segs(2) }),
		);
		expect(drift._tag).toBe("Failure");
	});

	it("fails as PortError when the file is missing or not an object", async () => {
		const gone = await Effect.runPromiseExit(
			select(makeScoresFileCleanupGate({ path: path.join(dir, "gone.json") }), {
				sampleId: "s1",
				text,
				segments: segs(1),
			}),
		);
		expect(gone._tag).toBe("Failure");
		fs.writeFileSync(file, "[1,2]");
		const notObj = await Effect.runPromiseExit(
			select(makeScoresFileCleanupGate({ path: file }), {
				sampleId: "s1",
				text,
				segments: segs(1),
			}),
		);
		expect(notObj._tag).toBe("Failure");
	});
});
