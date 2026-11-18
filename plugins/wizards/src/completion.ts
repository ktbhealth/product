import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DocumentStore } from "@ktb/document-store";

import { resolveTemplate } from "@ktb/dsl";

import type { WizardCompletion, WizardDefinition } from "./definition.ts";
import { WizardHooks, type WizardRunHandle } from "./hooks.ts";

/**
 * Completion targets — what a finished run produces. Two kinds:
 *
 * - `document-store`: insert a record into a document collection with
 *   the run owner as `ownerId` attribution. The store is resolved via
 *   `Effect.serviceOption` — wizards stay usable when the
 *   document-store plugin's surface is off (the service layer still
 *   composes; a missing service fails the completion loudly instead of
 *   silently dropping the write).
 * - `hook`: invoke a handler registered on {@link WizardHooks} — the
 *   escape hatch for completions that need domain logic (notifications,
 *   patient-record links, …). Handlers own their own authorization;
 *   see the trust contract in ./hooks.ts.
 *
 * `data` templates: string values of the form `"$<scope>.<path>"`
 * resolve against `{ answers, wizard, run }` (dot path via
 * @ktb/dsl `resolveTemplate`); `"$answers.<stepId>.<field>"` is the
 * common case. Non-string values and non-`$` strings pass through
 * literally.
 */

/** Completion could not run — unknown collection/hook, template or
 * downstream store error. Surfaced to the run service which records
 * the run as completed anyway? NO — see service.ts: completion
 * failures FAIL the advance so the user can retry. */
export class CompletionFailed extends Data.TaggedError("CompletionFailed")<{
	readonly reason: string;
}> {}

/** Everything template resolution + targets need from the run. */
export interface CompletionContext {
	readonly run: {
		readonly id: number;
		readonly key: string;
		readonly ownerId: string;
	};
	readonly definition: WizardDefinition;
	readonly answers: Readonly<Record<string, unknown>>;
}

/** Expand every `data` template against the run scope. */
export const resolveCompletionData = (
	data: Readonly<Record<string, unknown>> | undefined,
	ctx: CompletionContext,
): Record<string, unknown> => {
	if (data === undefined) return {};
	const scope: Record<string, unknown> = {
		answers: ctx.answers,
		wizard: { id: ctx.definition.id, title: ctx.definition.title },
		run: { id: ctx.run.id, key: ctx.run.key },
	};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		// defineProperty, not assignment: a "__proto__" data key must
		// become an own data property, never hit the prototype setter.
		Object.defineProperty(out, key, {
			value: resolveTemplate(value, scope),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return out;
};

const runDocumentStoreTarget = (
	completion: Extract<WizardCompletion, { kind: "document-store" }>,
	ctx: CompletionContext,
): Effect.Effect<void, CompletionFailed, never> =>
	Effect.gen(function* () {
		const store = yield* Effect.serviceOption(DocumentStore);
		if (Option.isNone(store)) {
			return yield* Effect.fail(
				new CompletionFailed({
					reason: `document-store completion needs the DocumentStore service (collection "${completion.collection}")`,
				}),
			);
		}
		const data = resolveCompletionData(completion.data, ctx);
		yield* store.value.insert(completion.collection, data, { ownerId: ctx.run.ownerId }).pipe(
			Effect.mapError(
				(error) =>
					new CompletionFailed({
						reason: `document-store insert into "${completion.collection}" failed: ${String(error)}`,
					}),
			),
		);
	});

const runHookTarget = (
	completion: Extract<WizardCompletion, { kind: "hook" }>,
	ctx: CompletionContext,
): Effect.Effect<void, CompletionFailed, WizardHooks> =>
	Effect.gen(function* () {
		const hooks = yield* WizardHooks;
		const payload = resolveCompletionData(completion.data, ctx);
		const runHandle: WizardRunHandle = {
			id: ctx.run.id,
			key: ctx.run.key,
			ownerId: ctx.run.ownerId,
			definition: ctx.definition,
			answers: ctx.answers,
			payload,
		};
		yield* hooks.invoke(completion.hook, runHandle).pipe(
			Effect.mapError(
				(error) =>
					new CompletionFailed({
						reason: `hook "${completion.hook}" failed: ${String(error)}`,
					}),
			),
		);
	});

/** Fire the definition's completion target, if any. Returns the
 * resolved payload for callers that want to record it. */
export const runCompletion = (
	completion: WizardCompletion | undefined,
	ctx: CompletionContext,
): Effect.Effect<Record<string, unknown> | null, CompletionFailed, WizardHooks> => {
	if (completion === undefined) return Effect.succeed(null);
	if (completion.kind === "document-store") {
		return runDocumentStoreTarget(completion, ctx).pipe(
			Effect.map(() => resolveCompletionData(completion.data, ctx)),
		);
	}
	return runHookTarget(completion, ctx).pipe(
		Effect.map(() => resolveCompletionData(completion.data, ctx)),
	);
};
