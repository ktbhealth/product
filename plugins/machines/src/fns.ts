import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { optionalSessionHandler, sessionHandler } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";

import { Machines, type MachineCard } from "./machines.ts";
import type { MachineKind } from "./schema.ts";

// Machine registry server functions (P-098 D1/D2): platform-scope CRUD
// plus health probes. Every fn calls the Machines service, which
// enforces PlatformAdmin for platform scope — denials collapse to
// `{ ok: false }` / `[]` like the other admin surfaces.
//
// `machinesBeatFn` is the agent heartbeat path: the service treats the
// machine id as the capability (system callers, no Principal), so the
// fn itself re-checks the PlatformAdmin gate — until agent tokens
// land, only admins may spoof a heartbeat. Agent token auth is a
// later iteration.

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
		/* v8 ignore next -- platform-scope fns never reach the tenant gate */
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
	optionalSessionHandler(
		() => [],
		async ({ run }): Promise<readonly MachineCard[]> => {
			return run(
				Effect.gen(function* () {
					const machines = yield* Machines;
					return yield* machines.list({ scope: "platform" }).pipe(denyToFalse([] as MachineCard[]));
				}),
			);
		},
	),
);

export const machinesCreateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<MachineCard>> => {
			return run(
				Effect.gen(function* () {
					const machines = yield* Machines;
					return yield* machines.create(toCreateInput(data)).pipe(
						Effect.map((card) => ({ ok: true as const, data: card })),
						denyToFalse({ ok: false as const }),
					);
				}),
			);
		}),
	);

export const machinesUpdateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<MachineCard>> => {
			return run(
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
		}),
	);

export const machinesRemoveFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.gen(function* () {
					const machines = yield* Machines;
					return yield* machines.remove(data.id).pipe(
						Effect.map(() => ({ ok: true as const, data: null })),
						denyToFalse({ ok: false as const }),
					);
				}),
			);
		}),
	);

/** Probe one machine's health — persists status/lastCheckAt. */
export const machinesCheckFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<MachineCard | null>> => {
			return run(
				Effect.gen(function* () {
					const machines = yield* Machines;
					return yield* machines.check(data.id).pipe(
						Effect.map((card) => ({ ok: true as const, data: card })),
						denyToFalse({ ok: false as const }),
					);
				}),
			);
		}),
	);

/** Probe every platform machine — returns refreshed cards. */
export const machinesCheckAllFn = createServerFn({ method: "POST" }).handler(
	sessionHandler(async ({ run }): Promise<Result<readonly MachineCard[]>> => {
		return run(
			Effect.gen(function* () {
				const machines = yield* Machines;
				return yield* machines.checkAll({ scope: "platform" }).pipe(
					Effect.map((cards) => ({ ok: true as const, data: cards })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	}),
);

/** Agent heartbeat — stamps lastSeenAt and marks the machine online.
 * The service treats the machine id as the capability for system
 * callers; this fn re-checks PlatformAdmin so an arbitrary session
 * cannot spoof health signals until agent tokens land. */
export const machinesBeatFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<Result<null>> => {
			return run(
				Effect.gen(function* () {
					const platformAdmin = yield* PlatformAdmin;
					yield* platformAdmin.requireAdmin();
					const machines = yield* Machines;
					return yield* machines
						.beat(data.id)
						.pipe(Effect.map(() => ({ ok: true as const, data: null })));
				}).pipe(denyToFalse({ ok: false as const })),
			);
		}),
	);
