import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";
import type { Json } from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";

import { Flows, type FlowEventInput, type FlowTargetInput } from "./service.ts";

export type { FlowEventInput, FlowTargetInput };

// Flows server functions: the wire surface for `flow.def` state
// machines. Every call is session-gated — transitions WRITE
// documents, so they run under `runAs` with the bound Principal
// supplying DocumentStore's owner/tenant fencing (a caller can never
// transition a record outside its visible scope). Handled domain
// failures (unknown flow, missing/invisible record, illegal
// transition, state conflict, denied permission, store validation)
// collapse to null/false — the same "not visible / not saved"
// contract the other plugin fns use; unexpected errors propagate.
//
// v1 is headless: these fns are the API other UI (or external callers
// via createServerFn RPC) drive; no pages ship with the plugin.

/** `currentState` wire shape. */
export interface FlowStateWire {
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
	readonly state: string;
}

/** `transition` wire shape: the committed from→to plus the updated
 * record's data payload. */
export interface FlowTransitionWire {
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
	readonly event: string;
	readonly from: string;
	readonly to: string;
	readonly data: Json;
}

const TargetInput = Schema.Struct({
	flow: Schema.String,
	collection: Schema.String,
	id: Schema.Number,
});

const EventInput = Schema.Struct({
	flow: Schema.String,
	collection: Schema.String,
	id: Schema.Number,
	event: Schema.String,
	payload: Schema.optionalKey(Schema.Unknown),
});

const decodeTarget = Schema.decodeUnknownSync(TargetInput);
const decodeEvent = Schema.decodeUnknownSync(EventInput);

const HANDLED_TAGS = [
	"UnknownFlow",
	"FlowRecordNotFound",
	"IllegalTransition",
	"FlowStateConflict",
	"FlowPermissionDenied",
	// DocumentStoreError tags — store-side client-visible conditions.
	"UnknownCollection",
	"RecordNotFound",
	"DocumentValidationError",
	"InvalidDocumentQuery",
	"DuplicateFieldValue",
	"BrokenReference",
	"DocumentInUse",
] as const;

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(HANDLED_TAGS as readonly string[]).includes(String((error as { _tag?: unknown })._tag));

/** `null` for handled failures, rethrow otherwise. */
const orNull = <A>(promise: Promise<A>): Promise<A | null> =>
	promise.catch((error: unknown) => {
		if (isHandled(error)) return null;
		throw error;
	});

/** `false` for handled failures, rethrow otherwise. */
const orFalse = (promise: Promise<boolean>): Promise<boolean> =>
	promise.catch((error: unknown) => {
		if (isHandled(error)) return false;
		throw error;
	});

/** Run `eff` as the session user. */
const asUser = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> => runAs(user, eff);

/** The document's current flow state — `null` for unknown flows,
 * missing/invisible records and handled failures. */
export const flowStateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeTarget(input))
	.handler(async ({ data }): Promise<FlowStateWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const flows = yield* Flows;
					const info = yield* flows.currentState(data as FlowTargetInput);
					if (info === null) return null;
					return {
						flow: info.flow.id,
						collection: info.flow.collection,
						id: info.record.id,
						state: info.state,
					};
				}),
			),
		);
	});

/** Would `event` transition the document right now? `false` for
 * unknown flows, missing records, illegal transitions and handled
 * failures. */
export const canTransitionFlowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEvent(input))
	.handler(async ({ data }): Promise<boolean> => {
		const user = await ensureSessionUser();
		return orFalse(
			asUser(
				user,
				Effect.gen(function* () {
					const flows = yield* Flows;
					return yield* flows.canTransition(data as FlowEventInput);
				}),
			),
		);
	});

/** Commit a transition — the atomic state+field write plus post-commit
 * hooks. `null` for every handled failure (unknown flow, invisible
 * record, illegal transition, state conflict, denied permission,
 * store validation). */
export const transitionFlowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEvent(input))
	.handler(async ({ data }): Promise<FlowTransitionWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const flows = yield* Flows;
					const result = yield* flows.transition(data as FlowEventInput);
					return {
						flow: result.flow.id,
						collection: result.flow.collection,
						id: result.record.id,
						event: data.event,
						from: result.from,
						to: result.to,
						data: result.record.data as unknown as Json,
					};
				}),
			),
		);
	});
