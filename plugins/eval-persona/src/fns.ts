import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, forbiddenTo, runAs, sessionHandler } from "@ktb/server-fns";

import {
	EvalInstances,
	EvalPersonas,
	type CreateInstanceInput,
	type InstanceCard,
	type InstanceDetail,
	type PersonaDefCard,
} from "./index.ts";

// Eval lab server fns: the /platform/eval/* surfaces mutate through
// these. Each service re-checks the eval.validator grant inside
// runAs; `Forbidden` collapses to `{ ok: false }` like the other
// admin fns, and domain rejections (`InstanceRejected`) carry their
// reason back in `data.message`. Wire inputs tolerate undefined/null
// keys the same way eval-validator's ReviewInput does.
//
// Note: like every other plugin's fns, these do NOT re-check plugin
// enablement — the plugin-enable gate lives on routes/panel pages
// (consistent with auth/patients/consultations fns).

const optStr = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const optNum = Schema.optional(Schema.Union([Schema.Number, Schema.Null]));

// Bounded counters — a bare Number lets a caller fan out 1e9 items in
// one request (self-DoS). `count` caps instances/defs per call,
// `defCount` caps items per spawned instance, seeds stay in int32+.
const boundedCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
const boundedDefCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));
const boundedSeed = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2147483647 }));
const optCount = Schema.optional(Schema.Union([boundedCount, Schema.Null]));
const optDefCount = Schema.optional(Schema.Union([boundedDefCount, Schema.Null]));
const optSeed = Schema.optional(Schema.Union([boundedSeed, Schema.Null]));

// Axis fields are literal-whitelisted — arbitrary strings would be
// persisted straight into stored personas otherwise.
const PersonaDefInput = Schema.Struct({
	id: optNum,
	name: Schema.String,
	patientName: Schema.String,
	gender: Schema.Literals(["female", "male"]),
	ageBand: Schema.Literals(["child", "adult", "elderly"]),
	socialClass: Schema.Literals(["low", "middle", "high"]),
	education: Schema.Literals(["primary", "secondary", "higher"]),
	region: Schema.Literals(["north", "northeast", "central", "southeast", "south"]),
	register: Schema.Literals(["colloquial", "neutral", "technical"]),
	specialty: Schema.Literals(["general_practice", "cardiology", "dermatology", "pediatrics"]),
	doctorGender: Schema.Literals(["female", "male"]),
	doctorRegister: Schema.Literals(["colloquial", "neutral", "technical"]),
	notes: optStr,
});
const IdInput = Schema.Struct({ id: Schema.Number });
const InstanceCreateInput = Schema.Struct({
	name: Schema.String,
	mode: Schema.Literals(["selected", "random"]),
	endpointId: optNum,
	defIds: Schema.optional(Schema.Union([Schema.Array(Schema.Number), Schema.Null])),
	count: optCount,
	seed: optSeed,
	minutes: optNum,
});
const GenerateInput = Schema.Struct({
	count: boundedCount,
	endpointId: optNum,
	seed: optSeed,
});
const SpawnInput = Schema.Struct({
	count: boundedCount,
	endpointId: optNum,
	defCount: optDefCount,
	seed: optSeed,
	name: optStr,
});

const decodeDef = Schema.decodeUnknownSync(PersonaDefInput);
const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeInstance = Schema.decodeUnknownSync(InstanceCreateInput);
const decodeGenerate = Schema.decodeUnknownSync(GenerateInput);
const decodeSpawn = Schema.decodeUnknownSync(SpawnInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

const run = <A, E>(
	user: Awaited<ReturnType<typeof ensureSessionUser>>,
	eff: Effect.Effect<A, E, unknown>,
) => runAs(user, Effect.scoped(eff));

const personaFrom = (d: Schema.Schema.Type<typeof PersonaDefInput>) => ({
	name: d.patientName,
	gender: d.gender === "male" ? "m" : "f",
	ageBand: d.ageBand,
	socialClass: d.socialClass,
	education: d.education,
	region: d.region,
	register: d.register,
	specialty: d.specialty,
	doctor: { gender: d.doctorGender === "male" ? "m" : "f", register: d.doctorRegister },
});

export const listPersonaDefsFn = createServerFn({ method: "GET" }).handler(
	sessionHandler(async ({ user }): Promise<Result<readonly PersonaDefCard[]>> => {
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* EvalPersonas;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(forbiddenTo({ ok: false as const })),
		);
	}),
);

export const savePersonaDefFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDef(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<{ id: number }>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalPersonas;
					const persona = personaFrom(data);
					const notes = data.notes == null ? undefined : data.notes;
					const r =
						data.id != null
							? yield* s
									.update({
										id: data.id,
										name: data.name,
										persona,
										...(notes !== undefined ? { notes } : {}),
									})
									.pipe(Effect.map(() => ({ id: data.id! })))
							: yield* s.create({
									name: data.name,
									persona,
									...(notes !== undefined ? { notes } : {}),
								});
					return { ok: true as const, data: r };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const generatePersonasFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeGenerate(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<{ created: number }>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalPersonas;
					const r = yield* s.generate({
						count: data.count,
						...(data.endpointId != null ? { endpointId: data.endpointId } : {}),
						...(data.seed != null ? { seed: data.seed } : {}),
					});
					return { ok: true as const, data: r };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const deletePersonaDefFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<null>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalPersonas;
					yield* s.remove(data.id);
					return { ok: true as const, data: null };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const listInstancesFn = createServerFn({ method: "GET" }).handler(
	sessionHandler(async ({ user }): Promise<Result<readonly InstanceCard[]>> => {
		return run(
			user,
			Effect.gen(function* () {
				const s = yield* EvalInstances;
				const data = yield* s.list();
				return { ok: true as const, data };
			}).pipe(forbiddenTo({ ok: false as const })),
		);
	}),
);

export const instanceDetailFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<InstanceDetail | null>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalInstances;
					const d = yield* s.detail(data.id);
					return { ok: true as const, data: d };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const createInstanceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeInstance(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<{ id: number }>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalInstances;
					const input: CreateInstanceInput = {
						name: data.name,
						mode: data.mode,
						...(data.endpointId != null ? { endpointId: data.endpointId } : {}),
						...(data.defIds != null ? { defIds: data.defIds } : {}),
						...(data.count != null ? { count: data.count } : {}),
						...(data.seed != null ? { seed: data.seed } : {}),
						...(data.minutes != null ? { minutes: data.minutes } : {}),
					};
					const r = yield* s.create(input);
					return { ok: true as const, data: r };
				}).pipe(
					forbiddenTo({ ok: false as const }),
					Effect.catchTag("InstanceRejected", (e) =>
						Effect.succeed({ ok: false as const, data: { message: e.reason } }),
					),
				),
			);
		}),
	);

export const startInstanceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<null>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalInstances;
					yield* s.start(data.id);
					return { ok: true as const, data: null };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);

export const deleteInstanceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(
			async ({ data, user }): Promise<Result<{ readonly message?: string } | null>> => {
				return run(
					user,
					Effect.gen(function* () {
						const s = yield* EvalInstances;
						yield* s.remove(data.id);
						return { ok: true as const, data: null };
					}).pipe(
						forbiddenTo({ ok: false as const }),
						Effect.catchTag("InstanceRejected", (e) =>
							Effect.succeed({ ok: false as const, data: { message: e.reason } }),
						),
					),
				);
			},
		),
	);

export const spawnInstancesFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSpawn(input))
	.handler(
		sessionHandler(async ({ data, user }): Promise<Result<{ created: number }>> => {
			return run(
				user,
				Effect.gen(function* () {
					const s = yield* EvalInstances;
					const r = yield* s.spawn({
						count: data.count,
						...(data.endpointId != null ? { endpointId: data.endpointId } : {}),
						...(data.defCount != null ? { defCount: data.defCount } : {}),
						...(data.seed != null ? { seed: data.seed } : {}),
						...(data.name != null ? { name: data.name } : {}),
					});
					return { ok: true as const, data: r };
				}).pipe(forbiddenTo({ ok: false as const })),
			);
		}),
	);
