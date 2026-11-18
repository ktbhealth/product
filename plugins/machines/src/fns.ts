import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, getSessionUser, runAs } from "@ktb/server-fns";

import { Machines, type MachineCard } from "./machines.ts";
import type { MachineKind } from "./schema.ts";

// Machine registry server functions (P-098 D1/D2): platform-scope CRUD
// plus health probes. Every fn calls the Machines service, which
// enforces PlatformAdmin for platform scope — denials collapse to
// `{ ok: false }` / `[]` like the other admin surfaces.
//
// `machinesBeatFn` is the agent heartbeat path: the service treats the
// machine id as the capability (system callers, no Principal). Agent
// token auth is a later iteration — for now it still requires a
// session like every server fn.

const MachineKindSchema = Schema.Literals(["shell", "vm", "gpu", "endpoint", "other"]);
const Capabilities = Schema.optionalKey(Schema.Array(Schema.NonEmptyString));

const CreateInput = Schema.Struct({
	name: Schema.NonEmptyString,
	kind: Schema.optionalKey(MachineKindSchema),
	host: Schema.NonEmptyString,
	port: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	capabilities: Capabilities,
	secretRef: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	healthUrl: Schema.optionalKey(Schema.NullishOr(Schema.String)),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optionalKey(Schema.NonEmptyString),
	kind: Schema.optionalKey(MachineKindSchema),
	host: Schema.optionalKey(Schema.NonEmptyString),
	port: Schema.optionalKey(Schema.NullishOr(Schema.Number)),
	capabilities: Capabilities,
	secretRef: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	healthUrl: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	enabled: Schema.optionalKey(Schema.Boolean),
});
const IdInput = Schema.Struct({ id: Schema.Number });

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/** Denials collapse to `{ ok: false }` / empty list — same convention
 * as the vault/credentials fns; unexpected errors still propagate. */
const denyToFalse = <A>(fallback: A) =>
	Effect.catchTags({
		MachineError: () => Effect.succeed(fallback),
		TenantForbidden: () => Effect.succeed(fallback),
		Forbidden: () => Effect.succeed(fallback),
	});

const toCreateInput = (data: typeof CreateInput.Type) => ({
	scope: "platform" as const,
	name: data.name,
	...(data.kind !== undefined ? { kind: data.kind as MachineKind } : {}),
	host: data.host,
	...(data.port !== undefined ? { port: data.port } : {}),
	...(data.capabilities !== undefined ? { capabilities: data.capabilities } : {}),
	...(data.secretRef !== undefined ? { secretRef: data.secretRef } : {}),
	...(data.healthUrl !== undefined ? { healthUrl: data.healthUrl } : {}),
});

/** Platform machine list — admin-only; denials degrade to []. */
export const machinesListFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly MachineCard[]> => {
		const user = await getSessionUser();
		if (!user) return [];
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.list({ scope: "platform" }).pipe(denyToFalse([] as MachineCard[]));
			}),
		);
	},
);

export const machinesCreateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<Result<MachineCard>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.create(toCreateInput(data)).pipe(
					Effect.map((card) => ({ ok: true as const, data: card })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

export const machinesUpdateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(async ({ data }): Promise<Result<MachineCard>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines
					.update({
						id: data.id,
						...(data.name !== undefined ? { name: data.name } : {}),
						...(data.kind !== undefined ? { kind: data.kind as MachineKind } : {}),
						...(data.host !== undefined ? { host: data.host } : {}),
						...(data.port !== undefined ? { port: data.port } : {}),
						...(data.capabilities !== undefined ? { capabilities: data.capabilities } : {}),
						...(data.secretRef !== undefined ? { secretRef: data.secretRef } : {}),
						...(data.healthUrl !== undefined ? { healthUrl: data.healthUrl } : {}),
						...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
					})
					.pipe(
						Effect.map((card) => ({ ok: true as const, data: card })),
						denyToFalse({ ok: false as const }),
					);
			}),
		);
	});

export const machinesRemoveFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.remove(data.id).pipe(
					Effect.map(() => ({ ok: true as const, data: null })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Probe one machine's health — persists status/lastCheckAt. */
export const machinesCheckFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<MachineCard | null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.check(data.id).pipe(
					Effect.map((card) => ({ ok: true as const, data: card })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Probe every platform machine — returns refreshed cards. */
export const machinesCheckAllFn = createServerFn({ method: "POST" }).handler(
	async (): Promise<Result<readonly MachineCard[]>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.checkAll({ scope: "platform" }).pipe(
					Effect.map((cards) => ({ ok: true as const, data: cards })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	},
);

/** Agent heartbeat — stamps lastSeenAt and marks the machine online.
 * The service treats the machine id as the capability; session-gated
 * here until agent tokens land. */
export const machinesBeatFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.beat(data.id).pipe(
					Effect.map(() => ({ ok: true as const, data: null })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});
