import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { Option } from "effect";
import { describe, expect, test, vi } from "vitest";

import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execSync: vi.fn<typeof execSync>() }));

import { PortError } from "@ktb/eval-core";

import { defaultContext, repoRoot } from "./context.ts";
import { UsageError } from "./errors.ts";
import {
	assertCapabilities,
	datasetVersionOf,
	gitSha,
	intFlag,
	isTransientBatchError,
	localeFlag,
	manifestHashOf,
	resolveFor,
	runStagePrompts,
	scriptTemplatePrompt,
	selectProfile,
	sha256Hex,
	workdirFlag,
} from "./shared.ts";
import type { LoadedSuite } from "./suites.ts";
import type { SuiteResolution } from "./resolve.ts";
import { defineSuite } from "@ktb/eval-core";

const suite = (over: Record<string, unknown> = {}): LoadedSuite => ({
	file: "<test>",
	manifest: defineSuite({
		id: "s",
		domain: "d",
		dataset: { id: "ds", version: "v2" },
		stages: [],
		caps: {},
		metrics: [],
		gates: [],
		schemaVersion: 1,
		...over,
	}),
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runErr = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("sha256Hex/manifestHashOf/gitSha (P-076)", () => {
	test("sha256Hex matches the known vector", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test("manifestHashOf is stable and content-sensitive", () => {
		const a = manifestHashOf(suite().manifest);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(manifestHashOf(suite().manifest)).toBe(a);
		expect(manifestHashOf(suite({ id: "other" }).manifest)).not.toBe(a);
	});

	test("gitSha trims stdout, and degrades to undefined", () => {
		const mock = vi.mocked(execSync);
		mock.mockReturnValue(Buffer.from("deadbeef\n") as never);
		expect(gitSha("/anywhere")).toBe("deadbeef");
		mock.mockReturnValue(Buffer.from("") as never);
		expect(gitSha("/anywhere")).toBeUndefined();
		mock.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		expect(gitSha("/anywhere")).toBeUndefined();
	});
});

describe("datasetVersionOf", () => {
	test("joins dataset id and version", () => {
		expect(datasetVersionOf(suite().manifest)).toBe("ds-v2");
	});
});

describe("selectProfile", () => {
	test("defaults to manifest.adapterProfile then stub", async () => {
		expect(await run(selectProfile(Option.none(), suite({ adapterProfile: "local" })))).toBe(
			"local",
		);
		expect(await run(selectProfile(Option.none(), suite()))).toBe("stub");
		expect(await run(selectProfile(Option.some("cloud"), suite({ adapterProfile: "local" })))).toBe(
			"cloud",
		);
	});

	test("unknown profile is a UsageError listing known profiles", async () => {
		const err = await runErr(selectProfile(Option.some("nope"), suite()));
		expect(err).toBeInstanceOf(UsageError);
		expect(err.message).toMatch(
			/stub, local, local-asr, local-jev, local-systemone, devin, local-devin, local-chat, local-devin-judge-stub, cloud/,
		);
	});
});

describe("resolveFor", () => {
	test("returns profile + resolution", () => {
		const r = resolveFor(suite({ caps: { asr: "transcription.asr" } }), "stub");
		expect(r.profile).toBe("stub");
		expect(r.resolution.adapters.asr).toBe("stub");
	});
});

describe("assertCapabilities", () => {
	test("passes when needed caps are resolved", async () => {
		const s = suite({ caps: { asr: "transcription.asr" } });
		const { profile, resolution } = resolveFor(s, "stub");
		await expect(run(assertCapabilities(s, profile, resolution, ["asr"]))).resolves.toBeUndefined();
	});

	test("fails naming every missing ref", async () => {
		const s = suite({ caps: { ghost: "x" } });
		const { profile, resolution } = resolveFor(s, "stub");
		const err = await runErr(assertCapabilities(s, profile, resolution, ["ghost"]));
		expect(err.message).toMatch(/ghost→x \(no registered contribution\)/);
	});

	test("names the profile and each missing cap's provider id (T-120)", async () => {
		const s = suite({
			caps: {
				asr: "transcription.asr",
				tts: "transcription.tts",
				llm: "llm.eval",
				eval: "llm.eval",
			},
		});
		const { profile, resolution } = resolveFor(s, "cloud");
		const err = await runErr(
			assertCapabilities(s, profile, resolution, ["asr", "tts", "llm", "eval"]),
		);
		// cloud satisfies asr (workers-ai) + llm/eval (workers-ai chat
		// models) but has no tts adapter — the error names the profile
		// and the exact cap→provider pairs that remain missing.
		expect(err.message).toContain('profile "cloud" cannot satisfy');
		expect(err.message).toContain("tts→transcription.tts");
		expect(err.message).not.toContain("asr→");
		expect(err.message).not.toContain("llm→");
		expect(err.message).not.toContain("eval→");
	});

	test("formats non-capability refs and provider-less capability refs", async () => {
		// A needed id can collide with a non-capability ref kind (e.g. a
		// gate literally named "asr") — the detail line must render the
		// generic `kind "id"` form, not a cap→provider arrow.
		const s = suite({ caps: {} });
		const { profile } = resolveFor(s, "stub");
		const resolution: SuiteResolution = {
			resolved: [],
			unresolved: [
				{ kind: "eval.gate", id: "asr", reason: "no registered contribution" },
				// eval.capability unresolved WITHOUT a caps entry — the
				// provider lookup misses and falls back to the same
				// generic form.
				{ kind: "eval.capability", id: "llm", reason: 'profile "stub" selects no adapter' },
			],
			adapters: {},
			gates: [],
			configErrors: [],
		};
		const err = await runErr(assertCapabilities(s, profile, resolution, ["asr", "llm"]));
		expect(err.message).toContain('eval.gate "asr" (no registered contribution)');
		expect(err.message).toContain('eval.capability "llm"');
	});
});

describe("intFlag", () => {
	test("absent flag returns the default even below the floor", async () => {
		expect(await run(intFlag("limit", Option.none(), 0, 1))).toBe(0);
	});

	test("present flag must be an integer >= min", async () => {
		expect(await run(intFlag("limit", Option.some(3), 0, 1))).toBe(3);
		const err = await runErr(intFlag("limit", Option.some(0), 0, 1));
		expect(err).toBeInstanceOf(UsageError);
		expect(err.message).toMatch(/--limit must be an integer >= 1/);
	});
});

describe("localeFlag", () => {
	test("defaults to pt-BR and resolves known locales", async () => {
		expect((await run(localeFlag(Option.none()))).id).toBe("ptbr-v1");
		expect((await run(localeFlag(Option.some("pt-BR")))).asrLanguage).toBe("pt");
	});

	test("unknown locale is a UsageError listing the known set", async () => {
		const err = await runErr(localeFlag(Option.some("en")));
		expect(err).toBeInstanceOf(UsageError);
		expect(err.message).toMatch(/unknown --locale en/);
	});
});

describe("isTransientBatchError", () => {
	test("deterministic domain ports are permanent; everything else retries", () => {
		for (const port of ["phi", "pipeline", "generate"]) {
			expect(isTransientBatchError(new PortError({ port, message: "x" }))).toBe(false);
		}
		expect(isTransientBatchError(new PortError({ port: "asr", message: "x" }))).toBe(true);
		expect(isTransientBatchError(new PortError({ port: "tts", message: "x" }))).toBe(true);
		expect(isTransientBatchError(new Error("boom"))).toBe(true);
	});
});

describe("workdirFlag", () => {
	test("defaults under os.tmpdir()", async () => {
		const w = await run(workdirFlag(Option.none()));
		expect(w.startsWith(path.resolve(os.tmpdir()))).toBe(true);
	});

	test("accepts a scratch path under tmpdir", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-wd-"));
		fs.rmSync(dir, { recursive: true, force: true });
		expect(await run(workdirFlag(Option.some(dir)))).toBe(dir);
	});

	test("rejects non-scratch paths", async () => {
		const err = await runErr(workdirFlag(Option.some("/etc")));
		expect(err).toBeInstanceOf(UsageError);
		expect(err.message).toMatch(/--workdir must live/);
	});

	test("EVAL_WORKDIR_ROOTS extends the scratch allowlist", async () => {
		// A root outside tmpdir and <cwd>/tmp is only reachable via the
		// operator-declared env allowlist.
		const root = path.join(path.parse(os.tmpdir()).root, "ktb-eval-extra-root");
		const inside = path.join(root, "nested", "wd");
		const prev = process.env.EVAL_WORKDIR_ROOTS;
		// Trailing delimiter exercises the empty-entry filter.
		process.env.EVAL_WORKDIR_ROOTS = `${root}${path.delimiter}`;
		try {
			expect(await run(workdirFlag(Option.some(inside)))).toBe(path.resolve(inside));
			// The default still resolves under tmpdir.
			const def = await run(workdirFlag(Option.none()));
			expect(def.startsWith(path.resolve(os.tmpdir()))).toBe(true);
		} finally {
			if (prev === undefined) {
				delete process.env.EVAL_WORKDIR_ROOTS;
			} else {
				process.env.EVAL_WORKDIR_ROOTS = prev;
			}
		}
	});
});

describe("prompt bindings (T-135)", () => {
	test("scriptTemplatePrompt pins name+version+fnv1a content hash", () => {
		const a = scriptTemplatePrompt("template-a");
		expect(a).toEqual({
			name: "eval.consultation/script-template",
			version: 1,
			hash: expect.stringMatching(/^[0-9a-f]{8}$/),
		});
		// Content-sensitive: a different template source hashes differently.
		expect(scriptTemplatePrompt("template-b").hash).not.toBe(a.hash);
		expect(scriptTemplatePrompt("template-a").hash).toBe(a.hash);
	});

	test("runStagePrompts maps LLM stages and skips prompt-less ones", () => {
		const prompts = runStagePrompts(["transcribe", "cleanup", "judge"]);
		expect(prompts.map((p) => p.name)).toEqual([
			"eval.consultation/cleanup-corrector",
			"eval.consultation/judge-questions",
		]);
		// Transcribe-only / empty selections record nothing.
		expect(runStagePrompts(["transcribe"])).toEqual([]);
		expect(runStagePrompts([])).toEqual([]);
		// Unknown stage ids contribute nothing rather than throwing.
		expect(runStagePrompts(["mystery"])).toEqual([]);
	});
});

test("repoRoot resolves to the monorepo root", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf8")) as {
		name?: string;
	};
	expect(pkg.name).toBe("ktb");
});

test("defaultContext derives evalsDir under repoRoot", () => {
	const c = defaultContext();
	expect(c.evalsDir).toBe(`${repoRoot()}evals`);
	expect(c.repoRoot).toBe(repoRoot());
});
