import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	Contribution,
	ContributionKind,
	ContributionRegistry,
	DuplicateContributionError,
	UnknownContributionError,
	type Contribution as ContributionType,
} from "./registry.ts";

const stage = (id: string, version = "1.0.0"): ContributionType => ({
	kind: "eval.stage",
	id,
	version,
});

describe("contribution schemas", () => {
	it("ContributionKind decodes each registered kind and rejects others", () => {
		const d = Schema.decodeUnknownSync(ContributionKind);
		for (const kind of [
			"eval.stage",
			"eval.metric",
			"eval.gate",
			"eval.gatepreset",
			"eval.condition",
			"eval.capability",
		] as const) {
			expect(d(kind)).toBe(kind);
		}
		expect(() => d("eval.bogus")).toThrowError(Schema.SchemaError);
		expect(() => d("")).toThrowError(Schema.SchemaError);
	});

	it("Contribution decodes kind/id/version/meta and rejects bad shapes", () => {
		const d = Schema.decodeUnknownSync(Contribution);
		const c = d({ kind: "eval.stage", id: "asr", version: "1", meta: { port: "p" } });
		expect(c).toEqual({ kind: "eval.stage", id: "asr", version: "1", meta: { port: "p" } });
		expect(d({ kind: "eval.stage", id: "asr", version: "1" }).meta).toBeUndefined();
		expect(() => d({ kind: "eval.bogus", id: "x", version: "1" })).toThrowError(Schema.SchemaError);
		expect(() => d({ kind: "eval.stage", id: "x" })).toThrowError(Schema.SchemaError);
		expect(() => d({ kind: "eval.stage", version: "1" })).toThrowError(Schema.SchemaError);
	});
});

describe("ContributionRegistry", () => {
	it("registers and looks up by kind+id", () => {
		const r = new ContributionRegistry();
		const c = stage("asr", "2.0.0");
		r.register(c);
		expect(r.get("eval.stage", "asr")).toBe(c);
		expect(r.has("eval.stage", "asr")).toBe(true);
	});

	it("same id under different kinds does not collide", () => {
		const r = new ContributionRegistry();
		r.register(stage("wer"));
		r.register({ kind: "eval.metric", id: "wer", version: "1.0.0" });
		expect(r.get("eval.stage", "wer").kind).toBe("eval.stage");
		expect(r.get("eval.metric", "wer").kind).toBe("eval.metric");
	});

	it("throws DuplicateContributionError on re-register", () => {
		const r = new ContributionRegistry();
		r.register(stage("asr"));
		try {
			r.register(stage("asr", "9.9.9"));
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(DuplicateContributionError);
			expect(e).toMatchObject({
				_tag: "DuplicateContributionError",
				kind: "eval.stage",
				id: "asr",
				version: "9.9.9",
			});
		}
	});

	it("throws UnknownContributionError on missing lookup", () => {
		const r = new ContributionRegistry();
		try {
			r.get("eval.gate", "nope");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(UnknownContributionError);
			expect(e).toMatchObject({ _tag: "UnknownContributionError", kind: "eval.gate", id: "nope" });
		}
		expect(r.has("eval.gate", "nope")).toBe(false);
	});

	it("list returns registration order, optionally filtered by kind", () => {
		const r = new ContributionRegistry();
		r.register(stage("asr"));
		r.register({ kind: "eval.metric", id: "wer", version: "1" });
		r.register(stage("cleanup"));
		r.register({
			kind: "eval.capability",
			id: "asr.pt",
			version: "1",
			meta: { adapter: "whisper" },
		});
		expect(r.list().map((c) => `${c.kind}:${c.id}`)).toEqual([
			"eval.stage:asr",
			"eval.metric:wer",
			"eval.stage:cleanup",
			"eval.capability:asr.pt",
		]);
		expect(r.list("eval.stage").map((c) => c.id)).toEqual(["asr", "cleanup"]);
		expect(r.list("eval.gate")).toEqual([]);
	});

	it("configValidator returns the declared validator or undefined (P-078)", () => {
		const r = new ContributionRegistry();
		const validate = () => ({ ok: true as const, config: {} });
		r.register({ ...stage("asr"), validateConfig: validate });
		r.register(stage("cleanup"));
		expect(r.configValidator("eval.stage", "asr")).toBe(validate);
		expect(r.configValidator("eval.stage", "cleanup")).toBeUndefined();
		// Unknown kind+id → undefined, never a throw.
		expect(r.configValidator("eval.gate", "ghost")).toBeUndefined();
		// get()/list() are runtime views — the validator rides along
		// (it lives beside the data, never inside `meta`, so serialized
		// contribution metadata stays pure JSON).
		expect(r.get("eval.stage", "asr").validateConfig).toBe(validate);
		expect(r.list("eval.stage")[0]?.validateConfig).toBe(validate);
		expect(JSON.stringify(r.get("eval.stage", "asr").meta ?? {})).not.toContain("validate");
	});
});
