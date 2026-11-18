import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { FlaskConicalIcon, Users2Icon } from "lucide-react";

import { AiEndpoints, type EndpointCard } from "@ktb/ai-provider";
import { Principal, type Forbidden } from "@ktb/authz";
import { Db, tx, type DbClient } from "@ktb/db";
import { doctors, patients, user as userTable } from "@ktb/db/schema";
import {
	buildScriptPrompt,
	DEFAULT_MATRIX,
	enrichPersona,
	LlmFactory,
	LlmPort,
	parseScriptTurns,
	renderScript,
	rng,
	ptBR,
	sampleMatrix,
	turnsToScript,
	voiceFor,
	type Persona,
} from "@ktb/eval-consultation";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";

import { InstancesPanelPage, PersonasPanelPage } from "./platform-page.tsx";
import {
	evalInstance,
	evalInstanceItem,
	evalPersonaDef,
	type EvalInstance,
	type EvalInstanceItem,
	type EvalPersonaDef,
} from "./schema.ts";

export { evalInstance, evalInstanceItem, evalPersonaDef } from "./schema.ts";
export type { EvalInstance, EvalInstanceItem, EvalPersonaDef } from "./schema.ts";

/** Permission the gate checks — same spelling as the rbac catalog
 * (`eval.validator`). Canonical home is this plugin: the eval lab is
 * the pipeline's base layer (steps 1–2) that step 3 depends on. The
 * validator plugin re-exports it for consumers that pin the spelling
 * through @ktb/eval-validator (ai-provider, credentials). */
export const EVAL_RESOURCE = "eval";
export const EVAL_ACTION = "validator";

// ---------------------------------------------------------------------------
// DTOs — what the panel pages and fns exchange (plain JSON on the wire).
// ---------------------------------------------------------------------------

export interface PersonaDefCard {
	readonly id: number;
	readonly name: string;
	readonly persona: Persona;
	readonly notes: string | null;
	readonly createdBy: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date | null;
}

export interface InstanceCard {
	readonly id: number;
	readonly name: string;
	readonly mode: string;
	readonly endpointId: number | null;
	readonly endpointName: string | null;
	readonly params: { readonly seed?: number; readonly count?: number; readonly minutes?: number };
	readonly status: string;
	readonly total: number;
	readonly done: number;
	readonly createdBy: string | null;
	readonly createdAt: Date;
}

export interface InstanceItemCard {
	readonly id: number;
	readonly instanceId: number;
	readonly personaDefId: number | null;
	readonly persona: Persona | null;
	/** Generation status: pending | generating | done | error. */
	readonly status: string;
	readonly error: string | null;
	/** llm | template — which script source rendered the dialogue. */
	readonly scriptMode: string | null;
	/** Review gate for step 3: under_review | approved | rejected. */
	readonly state: string;
}

export interface InstanceDetail extends InstanceCard {
	readonly items: readonly InstanceItemCard[];
	readonly pct: number;
}

const parseJson = <T>(s: string | null, fallback: T): T => {
	/* v8 ignore next -- callers null-check before calling; null arm is defensive */
	if (s === null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

const toDefCard = (row: EvalPersonaDef): PersonaDefCard => ({
	id: row.id,
	name: row.name,
	persona: parseJson(row.persona, {} as Persona),
	notes: row.notes,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toInstanceCard = (row: EvalInstance, endpointName: string | null): InstanceCard => ({
	id: row.id,
	name: row.name,
	mode: row.mode,
	endpointId: row.endpointId,
	endpointName,
	params: parseJson(row.params, {}),
	status: row.status,
	total: row.total,
	done: row.done,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
});

const toItemCard = (row: EvalInstanceItem): InstanceItemCard => ({
	id: row.id,
	instanceId: row.instanceId,
	personaDefId: row.personaDefId,
	persona: row.persona === null ? null : parseJson(row.persona, {} as Persona),
	status: row.status,
	error: row.error,
	scriptMode: row.scriptMode,
	state: row.state,
});

const AXIS_VALUES: Record<string, readonly string[]> = {
	ageBand: ["child", "teen", "adult", "elderly"],
	socialClass: ["low", "middle", "high"],
	education: ["primary", "secondary", "higher"],
	region: ["north", "northeast", "central", "southeast", "south"],
	register: ["colloquial", "neutral", "technical"],
	specialty: ["general_practice", "cardiology", "dermatology", "pediatrics"],
	gender: ["f", "m"],
	doctorRegister: ["colloquial", "neutral", "technical"],
};

const sanitizeAxis = (axis: string, v: unknown): string | undefined =>
	typeof v === "string" && AXIS_VALUES[axis]?.includes(v) ? v : undefined;

/** Ask a bound endpoint for `count` persona definitions as JSON —
 * invalid/absent fields fall back to nothing (the caller tops up
 * with matrix samples). Endpoint resolution goes through the
 * AiEndpoints service — unknown/disabled rows and a missing plugin
 * both degrade to template sampling. */
const generateDefsViaLlm = (
	endpoints: AiEndpoints["Service"] | null,
	factory: LlmFactory["Service"] | null,
	endpointId: number,
	count: number,
	seed: number,
): Effect.Effect<{ name: string; persona: Persona; notes: string }[], never, unknown> =>
	Effect.gen(function* () {
		if (endpoints === null || factory === null) return [];
		const descriptor = yield* endpoints
			.resolve(endpointId)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		if (descriptor === null) return [];
		const layer = yield* factory.resolve(descriptor).pipe(Effect.catch(() => Effect.succeed(null)));
		if (layer === null) return [];
		const llm = yield* LlmPort.pipe(Effect.provide(layer));
		const prompt = `Generate ${count} diverse synthetic medical consultation personas for pt-BR eval, as a JSON array. Each item: {"name": string, "patientName": string, "gender": "f"|"m", "ageBand": "child"|"teen"|"adult"|"elderly", "socialClass": "low"|"middle"|"high", "education": "primary"|"secondary"|"higher", "region": "north"|"northeast"|"central"|"southeast"|"south", "register": "colloquial"|"neutral"|"technical", "specialty": "general_practice"|"cardiology"|"dermatology"|"pediatrics", "doctorGender": "f"|"m", "doctorRegister": "neutral"|"technical", "notes": string}. Respond with JSON only, no prose. Seed hint: ${seed}. Constraints: education must fit ageBand (child: "primary" only; teen: "primary"/"secondary"; never "higher" for minors); pediatrics implies ageBand "child" or "teen".`;
		const out = yield* llm
			.generate({
				taskId: `eval-persona-gen-${seed}`,
				role: "generator",
				input: prompt,
				outputSchema: "PersonaDefList",
				seed,
			})
			.pipe(Effect.catch(() => Effect.succeed({ text: "" })));
		const text = out.text;
		const m = text.match(/\[[\s\S]*\]/);
		if (m === null) return [];
		let raw: unknown;
		try {
			raw = JSON.parse(m[0]);
		} catch {
			return [];
		}
		/* v8 ignore next -- bracket-delimited JSON parses to arrays or throws */
		if (!Array.isArray(raw)) return [];
		const defs: { name: string; persona: Persona; notes: string }[] = [];
		for (const item of raw) {
			if (typeof item !== "object" || item === null) continue;
			const it = item as Record<string, unknown>;
			const field = (axis: string, key: string) => sanitizeAxis(axis, it[key]);
			const ageBand = field("ageBand", "ageBand") ?? "adult";
			const education = field("education", "education");
			const persona: Persona = {
				...(typeof it.patientName === "string" ? { name: it.patientName } : {}),
				...(field("gender", "gender") !== undefined ? { gender: field("gender", "gender") } : {}),
				// Coherence clamps — an LLM may pair a child with a
				// degree, or pediatrics with an elderly band; the eval
				// measures transcription, not generator bugs.
				ageBand:
					field("specialty", "specialty") === "pediatrics" &&
					ageBand !== "child" &&
					ageBand !== "teen"
						? "child"
						: ageBand,
				...(education !== undefined
					? {
							education:
								ageBand === "child"
									? "primary"
									: ageBand === "teen" && education === "higher"
										? "secondary"
										: education,
						}
					: {}),
				...(field("socialClass", "socialClass") !== undefined
					? { socialClass: field("socialClass", "socialClass") }
					: {}),
				region: field("region", "region") ?? "southeast",
				register: field("register", "register") ?? "neutral",
				specialty: field("specialty", "specialty") ?? "general_practice",
				doctor: {
					gender: field("gender", "doctorGender") ?? "f",
					register: field("doctorRegister", "doctorRegister") ?? "neutral",
				},
			};
			defs.push({
				name: typeof it.name === "string" ? it.name : (persona.name ?? "Persona"),
				persona,
				notes: typeof it.notes === "string" ? it.notes : "llm-generated",
			});
		}
		return defs;
	}).pipe(
		/* v8 ignore next -- belt: every inner path already degrades to [] */
		Effect.catchDefect(() => Effect.succeed([])),
	);

const requireGrant = Effect.fn("EvalLab.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

/** Representative birth date for an ageBand — synthetic patients get
 * a plausible year, never a real identity. */
const birthDateFor = (ageBand: string | undefined): string => {
	const year = new Date().getFullYear();
	switch (ageBand) {
		case "child":
			return `${year - 9}-01-01`;
		case "teen":
			return `${year - 15}-01-01`;
		case "elderly":
			return `${year - 70}-01-01`;
		default:
			return `${year - 35}-01-01`;
	}
};

const FHIR_GENDER: Record<string, string> = { f: "female", m: "male" };

/** Synthetic doctor display names — clearly generated, still human-
 * readable for the validator UI and admin listings. */
const DOCTOR_TAGS: Readonly<Record<string, readonly string[]>> = {
	f: ["Dra. Lemos", "Dra. Prado", "Dra. Reis", "Dra. Fontes"],
	m: ["Dr. Salles", "Dr. Vasco", "Dr. Peña", "Dr. Moura"],
};

/** Atomic synthetic user+doctor+patient triple for one generated
 * consultation — everything flagged `synthetic`, related only to
 * itself. The item row links the ids so rejection (step 3) can clean
 * them up. */
export const insertSyntheticEntities = (
	db: DbClient,
	input: {
		readonly synUserId: string;
		readonly index: number;
		readonly persona: Persona;
	},
): Promise<{ readonly doctorId: number; readonly patientId: number }> => {
	const docGender = input.persona.doctor?.gender === "m" ? "m" : "f";
	const displayName = DOCTOR_TAGS[docGender]![input.index % DOCTOR_TAGS[docGender]!.length]!;
	return tx(db, [
		db.insert(userTable).values({
			id: input.synUserId,
			name: displayName,
			email: `${input.synUserId}@eval.ktb`,
			createdAt: new Date(),
			updatedAt: new Date(),
		}),
		db
			.insert(doctors)
			.values({
				userId: input.synUserId,
				displayName,
				/* v8 ignore next -- enrichPersona always fills specialty from the matrix cell */
				specialty: input.persona.specialty ?? null,
				synthetic: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.returning({ id: doctors.id }),
		db
			.insert(patients)
			.values({
				ownerId: input.synUserId,
				/* v8 ignore next -- enrichPersona always fills name/gender from the locale tables */
				name: input.persona.name ?? "Paciente",
				/* v8 ignore next -- persona.gender is f|m, both in FHIR_GENDER; "unknown" is schema-defensive */
				gender: FHIR_GENDER[input.persona.gender ?? "f"] ?? "unknown",
				birthDate: birthDateFor(input.persona.ageBand),
				synthetic: true,
				createdAt: new Date(),
			})
			.returning({ id: patients.id }),
	]).then(([, docRows, patRows]) => ({
		doctorId: docRows[0]!.id,
		patientId: patRows[0]!.id,
	}));
};

/** Deterministic seeded sample WITHOUT replacement — partial
 * Fisher-Yates over the shared rng: the same (rows, count, seed)
 * always picks the same personas, so a random-mode instance replays
 * exactly from its recorded params. */
const seededPick = <T>(rows: readonly T[], count: number, seed: number): readonly T[] => {
	const rand = rng(seed);
	const pool = [...rows];
	const out: T[] = [];
	for (let i = 0; i < Math.min(count, pool.length); i++) {
		const j = i + Math.floor(rand() * (pool.length - i));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
		out.push(pool[i]!);
	}
	return out;
};

// ---------------------------------------------------------------------------
// EvalPersonas — CRUD of curated persona definitions (the eval setup).
// ---------------------------------------------------------------------------

export class EvalPersonas extends Context.Service<
	EvalPersonas,
	{
		readonly list: () => Effect.Effect<readonly PersonaDefCard[], Forbidden, unknown>;
		readonly create: (input: {
			readonly name: string;
			readonly persona: Persona;
			readonly notes?: string;
		}) => Effect.Effect<{ readonly id: number }, Forbidden, unknown>;
		readonly update: (input: {
			readonly id: number;
			readonly name: string;
			readonly persona: Persona;
			readonly notes?: string;
		}) => Effect.Effect<void, Forbidden, unknown>;
		readonly remove: (id: number) => Effect.Effect<void, Forbidden, unknown>;
		/** Bulk-generate persona defs: LLM-driven when an endpoint is
		 * bound, deterministic matrix sampling otherwise. */
		readonly generate: (input: {
			readonly count: number;
			readonly endpointId?: number;
			readonly seed?: number;
		}) => Effect.Effect<{ readonly created: number }, Forbidden, unknown>;
	}
>()("@ktb/eval-persona/EvalPersonas") {}

export const EvalPersonasLive = Layer.effect(
	EvalPersonas,
	Effect.gen(function* () {
		const db = yield* Db;
		const endpoints = yield* Effect.serviceOption(AiEndpoints);
		const factory = yield* Effect.serviceOption(LlmFactory);
		return EvalPersonas.of({
			list: Effect.fn("EvalPersonas.list")(function* () {
				yield* requireGrant();
				const rows = yield* Effect.promise(() =>
					db.select().from(evalPersonaDef).orderBy(desc(evalPersonaDef.id)),
				);
				return rows.map(toDefCard);
			}),
			create: Effect.fn("EvalPersonas.create")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const rows = yield* Effect.promise(() =>
					db
						.insert(evalPersonaDef)
						.values({
							name: input.name,
							persona: JSON.stringify(input.persona),
							notes: input.notes ?? null,
							createdBy: principal?.email ?? null,
							createdAt: new Date(),
						})
						.returning({ id: evalPersonaDef.id }),
				);
				return { id: rows[0]!.id };
			}),
			update: Effect.fn("EvalPersonas.update")(function* (input) {
				yield* requireGrant();
				yield* Effect.promise(() =>
					db
						.update(evalPersonaDef)
						.set({
							name: input.name,
							persona: JSON.stringify(input.persona),
							notes: input.notes ?? null,
							updatedAt: new Date(),
						})
						.where(eq(evalPersonaDef.id, input.id)),
				);
			}),
			remove: Effect.fn("EvalPersonas.remove")(function* (id) {
				yield* requireGrant();
				yield* Effect.promise(() => db.delete(evalPersonaDef).where(eq(evalPersonaDef.id, id)));
			}),
			generate: Effect.fn("EvalPersonas.generate")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const seed = input.seed ?? 100;
				// LLM path: one call asking for a JSON array of defs.
				const llmDefs = (
					input.endpointId === undefined
						? []
						: yield* generateDefsViaLlm(
								Option.getOrNull(endpoints),
								Option.getOrNull(factory),
								input.endpointId,
								input.count,
								seed,
							)
				).slice(0, input.count);
				const sampled =
					llmDefs.length >= input.count
						? []
						: sampleMatrix(DEFAULT_MATRIX, 1, seed)
								.slice(0, input.count - llmDefs.length)
								.map((cell, i) => {
									const p = enrichPersona(cell, rng(seed + i));
									return {
										/* v8 ignore next -- enrichPersona fills name; matrix cells carry region */
										name: `${p.name ?? "Paciente"} · ${cell.region ?? ""}`.trim(),
										persona: p,
										notes: `seed ${seed + i} — sampled`,
									};
								});
				const defs = [...llmDefs, ...sampled];
				for (const d of defs) {
					yield* Effect.promise(() =>
						db.insert(evalPersonaDef).values({
							name: d.name,
							persona: JSON.stringify(d.persona),
							notes: d.notes,
							createdBy: principal?.email ?? null,
							createdAt: new Date(),
						}),
					);
				}
				return { created: defs.length };
			}),
		});
	}),
);

// ---------------------------------------------------------------------------
// EvalInstances — generation runs: pick defs or sample randomly, then
// generate synthetic entities + scripts through the chosen endpoint.
// ---------------------------------------------------------------------------

export interface CreateInstanceInput {
	readonly name: string;
	readonly mode: "selected" | "random";
	readonly endpointId?: number;
	readonly defIds?: readonly number[];
	readonly count?: number;
	readonly seed?: number;
	readonly minutes?: number;
}

/** Domain rejection for instance create/remove — surfaces through the
 * server fns as `{ ok: false, data: { message } }`. */
export class InstanceRejected extends Data.TaggedError("InstanceRejected")<{
	readonly reason: string;
}> {}

/** A claimed item left `generating` longer than this was orphaned by
 * a killed request — the next tick reclaims it to `pending`. */
const STALE_CLAIM_MS = 60_000;

/** `list` ticks at most this many generating instances per call — a
 * long queue can't starve a single request. */
const MAX_TICKS_PER_POLL = 5;

export class EvalInstances extends Context.Service<
	EvalInstances,
	{
		readonly list: () => Effect.Effect<readonly InstanceCard[], Forbidden, unknown>;
		readonly detail: (id: number) => Effect.Effect<InstanceDetail | null, Forbidden, unknown>;
		readonly create: (
			input: CreateInstanceInput,
		) => Effect.Effect<{ readonly id: number }, Forbidden | InstanceRejected, unknown>;
		/** Bulk-provision `count` random-mode instances ("generators") —
		 * names `${name} #1..N`, seeds `seed+i`, each producing
		 * `defCount` personas. */
		readonly spawn: (input: {
			readonly count: number;
			readonly endpointId?: number;
			readonly defCount?: number;
			readonly seed?: number;
			readonly name?: string;
		}) => Effect.Effect<{ readonly created: number }, Forbidden, unknown>;
		readonly remove: (id: number) => Effect.Effect<void, Forbidden | InstanceRejected, unknown>;
		readonly start: (id: number) => Effect.Effect<void, Forbidden, unknown>;
	}
>()("@ktb/eval-persona/EvalInstances") {}

export const EvalInstancesLive = Layer.effect(
	EvalInstances,
	Effect.gen(function* () {
		const db = yield* Db;
		const factory = yield* Effect.serviceOption(LlmFactory);
		// Optional dep: without the ai-provider plugin every endpoint
		// binding degrades to template mode and names render as the
		// generic template label.
		const endpoints = yield* Effect.serviceOption(AiEndpoints);

		const endpointNames = Option.isNone(endpoints)
			? Effect.succeed(new Map<number, string>())
			: endpoints.value.list().pipe(
					Effect.map((rows) => new Map(rows.map((r) => [r.id, r.name] as const))),
					/* v8 ignore next -- callers gate first; a flipped grant yields empty names */
					Effect.catch(() => Effect.succeed(new Map<number, string>())),
				);

		// One corpus slot: entities + script land ON the item row — the
		// generated consultation IS the item (no parallel persona rows).
		const generateItem = (
			instanceId: number,
			item: EvalInstanceItem,
			persona: Persona,
			llmLayer: Layer.Layer<LlmPort> | null,
			minutes: number | undefined,
		) =>
			Effect.gen(function* () {
				const entities = yield* Effect.promise(() =>
					insertSyntheticEntities(db as DbClient, {
						synUserId: `syn-inst${instanceId}-${item.id}`,
						index: item.id,
						persona,
					}),
				);
				const llmTurns =
					llmLayer !== null
						? yield* Effect.flatMap(LlmPort, (llm) =>
								llm.generate({
									taskId: `eval-instance-${instanceId}-${item.id}`,
									role: "generator",
									input: buildPromptFor(persona, minutes),
									outputSchema: "ConsultationScript",
									seed: item.id,
								}),
							).pipe(
								Effect.provide(llmLayer),
								Effect.map((r) => parseScriptTurns(r.text)),
								// LLM down/unparseable → template keeps the item
								// usable; the item records which mode rendered.
								Effect.catch(() => Effect.succeed(null)),
							)
						: null;
				const rendered =
					llmTurns !== null
						? { script: turnsToScript(llmTurns), turns: llmTurns, mode: "llm" }
						: (() => {
								const r = renderScript({
									template: "",
									persona,
									seed: item.id,
									profile: ptBR,
									variant: "anamnesis",
									...(minutes !== undefined ? { minutes } : {}),
								});
								return { script: r.script, turns: r.turns, mode: "template" };
							})();
				const rand = rng(item.id);
				yield* Effect.promise(() =>
					db
						.update(evalInstanceItem)
						.set({
							status: "done",
							script: rendered.script,
							turns: JSON.stringify(rendered.turns),
							voices: JSON.stringify({
								doctor: voiceFor(persona.doctor?.gender, rand),
								patient: voiceFor(persona.gender, rand),
							}),
							patientId: entities.patientId,
							doctorId: entities.doctorId,
							scriptMode: rendered.mode,
						})
						.where(eq(evalInstanceItem.id, item.id)),
				);
			});

		/** Poll-driven generation: one pending item per call, claimed
		 * atomically (`status='pending'` guard + `claimed_at` stamp) so
		 * concurrent polls and multiple tabs can't double-process. Work
		 * runs INSIDE live requests — survives workerd request shutdown,
		 * dev reloads and crashes; a request killed mid-generation
		 * leaves its item `generating`, so claims older than
		 * STALE_CLAIM_MS are reclaimed to `pending` on the next tick —
		 * the run can't deadlock. Never throws into the caller —
		 * failures land on the item row. */
		const tick = Effect.fn("EvalInstances.tick")(function* (instanceId: number) {
			const [inst] = yield* Effect.promise(() =>
				db.select().from(evalInstance).where(eq(evalInstance.id, instanceId)),
			);
			/* v8 ignore next -- ticks only run for generating instances that exist */
			if (inst === undefined || inst.status !== "generating") return;
			const params = parseJson<{ seed?: number; count?: number; minutes?: number }>(
				inst.params,
				{},
			);
			// Init-level failure (reclaim + items scan) is PERSISTENT —
			// surface it as instance `failed` instead of spinning forever
			// on `generating` against a broken table.
			const initFailed = (cause: unknown) =>
				Effect.promise(() =>
					db.update(evalInstance).set({ status: "failed" }).where(eq(evalInstance.id, instanceId)),
				).pipe(Effect.andThen(Effect.fail(cause)));
			const items = yield* Effect.promise(async () => {
				// Reclaim stale claims BEFORE the pending scan: without
				// this, an item orphaned by a killed request stays
				// `generating` forever and `finalize` never fires. Rows
				// claimed before the `claimed_at` column existed (NULL)
				// count as stale.
				await db
					.update(evalInstanceItem)
					.set({ status: "pending", claimedAt: null })
					.where(
						and(
							eq(evalInstanceItem.instanceId, instanceId),
							eq(evalInstanceItem.status, "generating"),
							or(
								isNull(evalInstanceItem.claimedAt),
								lt(evalInstanceItem.claimedAt, new Date(Date.now() - STALE_CLAIM_MS)),
							),
						),
					);
				return db
					.select()
					.from(evalInstanceItem)
					.where(eq(evalInstanceItem.instanceId, instanceId))
					.orderBy(evalInstanceItem.id);
			}).pipe(Effect.catch(initFailed), Effect.catchDefect(initFailed));
			const pending = items.find((i) => i.status === "pending");
			if (pending === undefined) {
				const inFlight = items.some((i) => i.status === "generating");
				if (!inFlight) {
					const okCount = items.filter((i) => i.status === "done").length;
					yield* Effect.promise(() =>
						db
							.update(evalInstance)
							.set({
								status: okCount === 0 && items.length > 0 ? "failed" : "ready",
								done: items.filter((i) => i.status === "done" || i.status === "error").length,
							})
							.where(eq(evalInstance.id, instanceId)),
					);
				}
				return;
			}
			// Atomic claim — concurrent polls skip items already taken.
			const claimed = yield* Effect.promise(() =>
				db
					.update(evalInstanceItem)
					.set({ status: "generating", claimedAt: new Date() })
					.where(and(eq(evalInstanceItem.id, pending.id), eq(evalInstanceItem.status, "pending")))
					.returning({ id: evalInstanceItem.id }),
			);
			/* v8 ignore next -- second tick losing the claim is a no-op */
			if (claimed.length === 0) return;
			// AiEndpoints.resolve returns null for unknown/disabled rows —
			// those degrade to template mode like a missing plugin.
			const descriptor =
				inst.endpointId === null || Option.isNone(endpoints)
					? null
					: yield* endpoints.value
							.resolve(inst.endpointId)
							.pipe(Effect.catch(() => Effect.succeed(null)));
			const llmLayer =
				Option.isSome(factory) && descriptor !== null
					? yield* factory.value.resolve(descriptor).pipe(
							// Endpoint broken → template generation; the item still
							// completes and the mode column says so.
							Effect.catch(() => Effect.succeed(null)),
						)
					: null;
			// The persona snapshot lands on the item AT CREATE (both modes
			// pick from the registry there) — a null snapshot is corrupt
			// input, not a reason to re-derive personas here.
			const persona =
				pending.persona === null ? null : parseJson<Persona>(pending.persona, {} as Persona);
			// Per-item failure isolation: typed errors AND defects mark
			// the item `error` without killing the rest of the run.
			const recordError = (cause: unknown) =>
				Effect.promise(() =>
					db
						.update(evalInstanceItem)
						.set({ status: "error", error: String(cause) })
						.where(eq(evalInstanceItem.id, pending.id)),
				);
			yield* (
				persona === null
					? Effect.fail(new Error("item has no resolved persona — recreate the instance"))
					: generateItem(instanceId, pending, persona, llmLayer, params.minutes)
			).pipe(Effect.catch(recordError), Effect.catchDefect(recordError));
			yield* Effect.promise(() =>
				db
					.update(evalInstance)
					.set({
						done:
							items.filter(
								(it) =>
									it.id !== pending.id && it.status !== "pending" && it.status !== "generating",
							).length + 1,
					})
					.where(eq(evalInstance.id, instanceId)),
			);
		});

		// Tick wrapper: generation problems surface on item rows, never
		// as request failures — the poll keeps flowing.
		const tickQuietly = (instanceId: number) =>
			tick(instanceId).pipe(
				Effect.catch(() => Effect.void),
				Effect.catchDefect(() => Effect.void),
			);

		// Shared insert path — `create` is one run, `spawn` is the same
		// insert fanned out for bulk "generator" provisioning. Plain
		// async over a caller-supplied client so `spawn` can run the
		// whole fan-out inside ONE transaction (a drizzle D1
		// `transaction` is `BEGIN`/`COMMIT` over the same client); the
		// `ok:false` arm keeps domain rejections typed for `create`.
		const insertInstance = async (
			client: Pick<DbClient, "select" | "insert">,
			input: CreateInstanceInput,
			createdBy: string | null,
		): Promise<
			{ readonly ok: true; readonly id: number } | { readonly ok: false; readonly reason: string }
		> => {
			// Both modes resolve personas UPFRONT from the shared registry —
			// `eval_persona_def` is the single source of truth for personas
			// (step 1 owns every write); generation only consumes it.
			const all = await client.select().from(evalPersonaDef).orderBy(evalPersonaDef.id);
			if (input.mode === "selected") {
				const defIds = input.defIds ?? [];
				const byId = new Map(all.map((d) => [d.id, d] as const));
				const picked = defIds.map((id) => byId.get(id)).filter((d) => d !== undefined);
				if (picked.length === 0) {
					return {
						ok: false,
						reason: "selected mode needs at least one known persona def",
					};
				}
				const [inst] = await client
					.insert(evalInstance)
					.values({
						name: input.name,
						mode: input.mode,
						endpointId: input.endpointId ?? null,
						params: JSON.stringify({
							...(input.seed !== undefined ? { seed: input.seed } : {}),
							...(input.count !== undefined ? { count: input.count } : {}),
							...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
						}),
						// `total` counts the items actually inserted — unknown
						// defIds are dropped, not promised.
						total: picked.length,
						createdBy,
						createdAt: new Date(),
					})
					.returning();
				await client.insert(evalInstanceItem).values(
					picked.map((d) => ({
						instanceId: inst!.id,
						personaDefId: d.id,
						persona: d.persona,
						createdAt: new Date(),
					})),
				);
				return { ok: true, id: inst!.id };
			}
			// random mode — a seeded pick from the shared registry, never
			// new personas: "random sample" means sampling the registry,
			// not sampling the demographic matrix. count caps the pick
			// (defaults to the whole registry); params.count records what
			// was ASKED for so a short registry stays auditable.
			if (all.length === 0) {
				return {
					ok: false,
					reason: "random mode needs personas — create them on the Personas step first",
				};
			}
			const picked = seededPick(
				all,
				Math.min(input.count ?? all.length, all.length),
				input.seed ?? 100,
			);
			const [inst] = await client
				.insert(evalInstance)
				.values({
					name: input.name,
					mode: input.mode,
					endpointId: input.endpointId ?? null,
					params: JSON.stringify({
						...(input.seed !== undefined ? { seed: input.seed } : {}),
						...(input.count !== undefined ? { count: input.count } : {}),
						...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
					}),
					total: picked.length,
					createdBy,
					createdAt: new Date(),
				})
				.returning();
			if (picked.length > 0) {
				await client.insert(evalInstanceItem).values(
					picked.map((d) => ({
						instanceId: inst!.id,
						personaDefId: d.id,
						persona: d.persona,
						createdAt: new Date(),
					})),
				);
			}
			return { ok: true, id: inst!.id };
		};

		return EvalInstances.of({
			list: Effect.fn("EvalInstances.list")(function* () {
				yield* requireGrant();
				const generating = yield* Effect.promise(() =>
					db
						.select({ id: evalInstance.id })
						.from(evalInstance)
						.where(eq(evalInstance.status, "generating"))
						.orderBy(evalInstance.id),
				);
				yield* Effect.forEach(
					// Bounded fan-out: a long generating queue must not turn
					// one poll into a sequential batch of every instance.
					generating.slice(0, MAX_TICKS_PER_POLL),
					(g) => tickQuietly(g.id),
					{ discard: true },
				);
				const [rows, names] = yield* Effect.all([
					Effect.promise(() => db.select().from(evalInstance).orderBy(desc(evalInstance.id))),
					endpointNames,
				]);
				return rows.map((r) =>
					toInstanceCard(
						r,
						/* v8 ignore next -- FK set null clears endpointId with the endpoint row */
						r.endpointId === null ? null : (names.get(r.endpointId) ?? null),
					),
				);
			}),
			detail: Effect.fn("EvalInstances.detail")(function* (id) {
				yield* requireGrant();
				yield* tickQuietly(id);
				const [row] = yield* Effect.promise(() =>
					db.select().from(evalInstance).where(eq(evalInstance.id, id)),
				);
				if (row === undefined) return null;
				const [items, names] = yield* Effect.all([
					Effect.promise(() =>
						db
							.select()
							.from(evalInstanceItem)
							.where(eq(evalInstanceItem.instanceId, id))
							.orderBy(evalInstanceItem.id),
					),
					endpointNames,
				]);
				return {
					...toInstanceCard(
						row,
						/* v8 ignore next -- FK set null clears endpointId with the endpoint row */
						row.endpointId === null ? null : (names.get(row.endpointId) ?? null),
					),
					items: items.map(toItemCard),
					pct: row.total === 0 ? 0 : Math.round((row.done / row.total) * 100),
				};
			}),
			create: Effect.fn("EvalInstances.create")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const r = yield* Effect.promise(() => insertInstance(db, input, principal?.email ?? null));
				if (!r.ok) return yield* new InstanceRejected({ reason: r.reason });
				return { id: r.id };
			}),
			spawn: Effect.fn("EvalInstances.spawn")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const base = input.name ?? "generator";
				const defCount = input.defCount ?? 3;
				const seed = input.seed ?? 100;
				// All-or-nothing fan-out: one transaction wraps every
				// insert so a mid-loop failure can't leave half-provisioned
				// "generator" instances behind.
				const created = yield* Effect.promise(() =>
					db.transaction(async (tx) => {
						let n = 0;
						for (let i = 0; i < input.count; i++) {
							const r = await insertInstance(
								tx,
								{
									name: `${base} #${i + 1}`,
									mode: "random",
									count: defCount,
									seed: seed + i,
									...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
								},
								principal?.email ?? null,
							);
							// random mode rejects on an empty registry —
							// inside the transaction the throw rolls the whole
							// fan-out back, same as a driver error.
							if (!r.ok) throw new Error(r.reason);
							n += 1;
						}
						return n;
					}),
				);
				return { created };
			}),
			remove: Effect.fn("EvalInstances.remove")(function* (id) {
				yield* requireGrant();
				// Refuse to orphan in-flight work: a `generating` instance
				// has items claimed by live (or stale-reclaimable) ticks.
				const [inst] = yield* Effect.promise(() =>
					db
						.select({ status: evalInstance.status })
						.from(evalInstance)
						.where(eq(evalInstance.id, id)),
				);
				if (inst?.status === "generating") {
					return yield* new InstanceRejected({
						reason: "instance is generating — wait for it to finish before removing",
					});
				}
				yield* Effect.promise(() => db.delete(evalInstance).where(eq(evalInstance.id, id)));
			}),
			start: Effect.fn("EvalInstances.start")(function* (id) {
				yield* requireGrant();
				const [inst] = yield* Effect.promise(() =>
					db.select().from(evalInstance).where(eq(evalInstance.id, id)),
				);
				if (inst === undefined || inst.status !== "draft") return;
				yield* Effect.promise(() =>
					db.update(evalInstance).set({ status: "generating" }).where(eq(evalInstance.id, id)),
				);
				// Poll-driven: no detached fiber — workerd kills pending
				// work when the request ends, orphaning rows mid-flight.
				// `detail`/`list` polls advance one item per call instead.
			}),
		});
	}),
);

const buildPromptFor = (persona: Persona, minutes: number | undefined): string =>
	buildScriptPrompt({ persona, ...(minutes !== undefined ? { minutes } : {}) });

// ---------------------------------------------------------------------------
// Plugin manifests
// ---------------------------------------------------------------------------

/** DDL mirror of schema.ts for in-memory test databases (same
 * contract as EVAL_VALIDATOR_TEST_DDL). */
export const EVAL_PERSONA_TEST_DDL = `
CREATE TABLE ai_endpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT, model TEXT, session_id TEXT, secret_ref TEXT, transport TEXT, agent_cmd TEXT, ssh_host TEXT, machine_id INTEGER, scope TEXT NOT NULL DEFAULT 'eval', is_default INTEGER NOT NULL DEFAULT 0, timeout_ms INTEGER NOT NULL DEFAULT 60000, enabled INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE eval_persona_def (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, persona TEXT NOT NULL, notes TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE TABLE eval_instance (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mode TEXT NOT NULL, endpoint_id INTEGER REFERENCES ai_endpoint(id) ON DELETE set null, params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE doctors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE cascade, display_name TEXT NOT NULL, crm TEXT, specialty TEXT, synthetic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE patients (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, tenant_id INTEGER, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, synthetic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE TABLE eval_instance_item (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER NOT NULL REFERENCES eval_instance(id) ON DELETE cascade, persona_def_id INTEGER REFERENCES eval_persona_def(id) ON DELETE set null, persona TEXT, script TEXT, turns TEXT, voices TEXT, patient_id INTEGER REFERENCES patients(id) ON DELETE set null, doctor_id INTEGER REFERENCES doctors(id) ON DELETE set null, script_mode TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, state TEXT NOT NULL DEFAULT 'under_review', feedback TEXT, reviewed_by TEXT, reviewed_at INTEGER, claimed_at INTEGER, created_at INTEGER NOT NULL);
`;

export const evalPersonaTablesPlugin = definePlugin({
	id: "eval.persona.tables",
	meta: { keywords: ["eval", "persona", "tables"] },
	// eval_instance.endpoint_id references ai_endpoint — ordering hint
	// only; the plugin works standalone (tests supply the table).
	optionalDeps: ["ai.provider.tables"],
	tables: { evalPersonaDef, evalInstance, evalInstanceItem },
});

export const evalPersonaServicesPlugin = definePlugin({
	id: "eval.persona.services",
	meta: { keywords: ["eval", "persona", "services"] },
	requiredDeps: [evalPersonaTablesPlugin.id],
	// Endpoint binding/resolution is a soft dep — AiEndpoints absence
	// degrades every endpoint pick to template mode.
	optionalDeps: ["ai.provider.services"],
	services: Layer.mergeAll(EvalPersonasLive, EvalInstancesLive),
});

export const evalPersonaChromePlugin = definePlugin({
	id: "eval.persona.chrome",
	meta: { keywords: ["eval", "persona", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "eval-personas.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval/personas",
					label: "1 · Personas",
					icon: Users2Icon,
					group: "Eval",
				},
			},
		},
		{
			id: "eval-instances.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval/instances",
					label: "2 · Generate consultations",
					icon: FlaskConicalIcon,
					group: "Eval",
				},
			},
		},
	],
});

export const evalPersonaPanelPlugin = definePlugin({
	id: "eval.persona.panel",
	meta: { keywords: ["eval", "persona", "ui"] },
	requiredDeps: [platformPanelPlugin.id, evalPersonaServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "eval.persona",
				path: "/platform/eval/personas",
				component: PersonasPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const personas = yield* EvalPersonas;
						return yield* personas
							.list()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as PersonaDefCard[])));
					}),
			},
			{
				id: "eval.instance",
				path: "/platform/eval/instances",
				component: InstancesPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const instances = yield* EvalInstances;
						const personas = yield* EvalPersonas;
						const endpoints = yield* Effect.serviceOption(AiEndpoints);
						// Eval pickers only offer eval-scope endpoints; without the
						// plugin the page still loads with an empty picker.
						const [instanceRows, defRows, endpointRows] = yield* Effect.all([
							instances.list(),
							personas.list(),
							Option.isNone(endpoints)
								? Effect.succeed([] as readonly EndpointCard[])
								: endpoints.value.list("eval"),
						]);
						return { instances: instanceRows, defs: defRows, endpoints: endpointRows };
					}).pipe(
						Effect.catchTag("Forbidden", () =>
							Effect.succeed({
								instances: [] as readonly InstanceCard[],
								defs: [] as readonly PersonaDefCard[],
								endpoints: [] as readonly EndpointCard[],
							}),
						),
					),
			},
		],
	},
});

export const plugins: readonly Plugin[] = [
	evalPersonaTablesPlugin,
	evalPersonaServicesPlugin,
	evalPersonaChromePlugin,
	evalPersonaPanelPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"eval.persona.tables": true;
		"eval.persona.services": true;
		"eval.persona.chrome": true;
		"eval.persona.panel": true;
	}
}
