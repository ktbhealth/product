import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, asc, eq } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { validate, type ValidationIssue } from "@ktb/json-schema";
import { defOwnerEnabled } from "@ktb/kernel";
import { PlatformAdmin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions, splitPermission } from "@ktb/rbac";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { runCompletion, type CompletionFailed } from "./completion.ts";
import {
	assertWizardDefinition,
	WIZARD_ID_PATTERN,
	WizardDefinitions,
	type WizardDefinition,
	type WizardStep,
} from "./definition.ts";
import { WizardHooksLive, type WizardHooks } from "./hooks.ts";
import {
	nextVisibleIndex,
	previousVisibleIndex,
	resolveCurrentStep,
	type StepResolution,
} from "./resolve.ts";
import { wizardDefs, wizardRuns, type WizardDefRow, type WizardRunRow } from "./schema.ts";

export type { WizardDefRow, WizardRunRow } from "./schema.ts";

/**
 * Wizards domain service: admin-authored definitions (`wizard_defs`)
 * plus per-user runs (`wizard_runs`) driven by the pure interpreter
 * in ./resolve.ts.
 *
 * Definition resolution at `startRun`: a `wizard_defs` row wins when
 * present (admins are authoritative — the client-supplied definition
 * is ignored); unpublished rows reject with `WizardNotPublished`.
 * Otherwise the client-supplied definition is validated, its `id`
 * must equal the requested key, AND it must deep-equal (canonical
 * JSON) a def in the `WizardDefinitions` registry — the code-
 * contribution path. A well-formed but unregistered def is a forgery
 * attempt (`ForbiddenWizardDefinition`): without this check any user
 * could snapshot a def whose completion writes arbitrary
 * document-store collections or invokes arbitrary WizardHooks.
 * Contributed defs owned by DISABLED plugins are likewise not honored
 * — runtime `PluginStates` enablement re-checked per `startRun`, same
 * contract as @ktb/views/@ktb/api (DB-authored `wizard_defs` rows are
 * admin content and unaffected).
 * Runs snapshot the resolved definition into `definition_json`, so
 * later def edits never mutate an in-flight run.
 *
 * `def.permission` (optional `"resource.action"`) gates `startRun`
 * through the OPTIONAL `Permissions` port — a declared permission
 * fails closed (`WizardPermissionDenied`) when no grant service is
 * bound, same contract as @ktb/flows.
 *
 * Runs are private to their owner (`owner_id` = bound Principal
 * userId); every run method re-checks ownership inside the service —
 * defense in depth behind the session-gated server fns.
 *
 * Completion is claim-then-fire: the run's answers/position persist
 * through an optimistic guarded update (`WizardRunConflict` on a
 * lost race), then a conditional `active → completing` claim makes
 * completion single-flight, then `completing → completed` closes the
 * run. A typed completion failure reverts the claim to `active` so
 * the next advance/complete retries; a crash mid-completion leaves
 * `completing`, which `recoverStaleClaim` reverts once the claim is
 * older than {@link COMPLETION_CLAIM_STALE_MS}. This is at-least-once:
 * a crash AFTER the side-effect but BEFORE the completed write can
 * re-fire the target on retry — document-store inserts and hooks
 * must tolerate that (same honesty contract as flows' hooks).
 */

export class InvalidWizardDefinition extends Data.TaggedError("InvalidWizardDefinition")<{
	readonly reason: string;
}> {}

export class WizardDefNotFound extends Data.TaggedError("WizardDefNotFound")<{
	readonly key: string;
}> {}

export class WizardNotPublished extends Data.TaggedError("WizardNotPublished")<{
	readonly key: string;
}> {}

export class WizardRunNotFound extends Data.TaggedError("WizardRunNotFound")<{
	readonly runId: number;
}> {}

/** The run exists but belongs to a different user — folded into
 * `Forbidden` semantics via the dedicated tag so fns can collapse it
 * to null without leaking existence. */
export class RunForbidden extends Data.TaggedError("RunForbidden")<{
	readonly runId: number;
}> {}

export class WizardNotActive extends Data.TaggedError("WizardNotActive")<{
	readonly runId: number;
	readonly status: string;
}> {}

/** `advance` named a step that isn't the run's current step. */
export class StepMismatch extends Data.TaggedError("StepMismatch")<{
	readonly runId: number;
	readonly expected: string;
	readonly got: string;
}> {}

/** A client-supplied definition failed the contributed-def registry
 * check — well-formed but not deep-equal to any `wizard.def`
 * contribution (forgery attempt). */
export class ForbiddenWizardDefinition extends Data.TaggedError("ForbiddenWizardDefinition")<{
	readonly key: string;
}> {}

/** `def.permission` was declared but the caller lacks the grant — or
 * no `Permissions` service is bound (fail closed). */
export class WizardPermissionDenied extends Data.TaggedError("WizardPermissionDenied")<{
	readonly key: string;
	readonly permission: string;
}> {}

/** A concurrent mutation won the optimistic guard — the run's stored
 * status/position/answers changed between read and write. */
export class WizardRunConflict extends Data.TaggedError("WizardRunConflict")<{
	readonly runId: number;
}> {}

/** The submitted step value failed server-side validation: either the
 * serialized value exceeds {@link MAX_STEP_VALUE_BYTES} or it violates
 * the step's JSON schema. `issues` carries the schema violations (or a
 * single synthetic size issue). */
export class InvalidStepValue extends Data.TaggedError("InvalidStepValue")<{
	readonly runId: number;
	readonly stepId: string;
	readonly issues: readonly ValidationIssue[];
}> {}

/** The stored run row can't be parsed/resolved — data corruption,
 * surfaced as a typed failure rather than a defect. */
export class CorruptWizardRun extends Data.TaggedError("CorruptWizardRun")<{
	readonly runId: number;
	readonly reason: string;
}> {}

export type WizardRunError =
	| Forbidden
	| InvalidWizardDefinition
	| WizardDefNotFound
	| WizardNotPublished
	| WizardRunNotFound
	| RunForbidden
	| WizardNotActive
	| StepMismatch
	| ForbiddenWizardDefinition
	| WizardPermissionDenied
	| WizardRunConflict
	| InvalidStepValue
	| CorruptWizardRun
	| CompletionFailed;

/** What the runner/admin UI consumes — the serializable run view. */
export interface WizardRunView {
	readonly id: number;
	readonly key: string;
	readonly status: "active" | "completed" | "abandoned";
	/** The resolved definition snapshot (title/description/steps). */
	readonly definition: WizardDefinition;
	/** Current step when active, else null. */
	readonly step: WizardStep | null;
	/** Declaration index of the current step (-1 when not active). */
	readonly stepIndex: number;
	/** Whether `back` can move anywhere. */
	readonly canGoBack: boolean;
	/** Best-effort: no visible step after the current one given the
	 * CURRENT answers — a next step's `when` may still depend on the
	 * pending submission, so `advance` is the source of truth. */
	readonly isLastStep: boolean;
	/** Submitted answers so far: step id → step value. */
	readonly answers: Record<string, unknown>;
}

/** Admin-facing definition row (wire shape lives in fns.ts). */
export interface WizardDefAdminRow {
	readonly key: string;
	readonly title: string;
	readonly description: string;
	readonly definition: WizardDefinition;
	readonly published: boolean;
	readonly updatedAt: Date;
}

export interface StartRunInput {
	readonly key: string;
	/** Client-supplied definition — used only when no `wizard_defs`
	 * row exists for `key` (the code-contribution path). Validated
	 * with assertWizardDefinition; `def.id` must equal `key`. */
	readonly definition?: unknown;
}

export interface AdvanceInput {
	/** Expected current step id — guards against stale clients. */
	readonly stepId?: string;
	/** The current step's submitted value (any JSON). */
	readonly value?: unknown;
}

export interface UpsertDefInput {
	readonly key: string;
	readonly title: string;
	readonly description?: string;
	/** Raw definition payload — validated before persisting. */
	readonly definition: unknown;
	readonly published?: boolean;
}

const asStatus = (value: string): WizardRunView["status"] =>
	value === "completed" || value === "abandoned" ? value : "active";

const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
};

/** `answers_json` must be a JSON object — anything else is corruption,
 * not an empty answer set (silently resetting would hide data loss). */
const parseAnswers = (
	raw: string,
	runId: number,
): Effect.Effect<Record<string, unknown>, CorruptWizardRun> => {
	const parsed = parseJson(raw);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? Effect.succeed(parsed as Record<string, unknown>)
		: Effect.fail(new CorruptWizardRun({ runId, reason: "answers_json is not a JSON object" }));
};

/** Serialized-size caps — a run's answers ride every view payload and
 * land in completion writes, so both the per-step value and the merged
 * answer set are bounded. */
export const MAX_STEP_VALUE_BYTES = 64 * 1024;
export const MAX_ANSWERS_BYTES = 256 * 1024;

/** JSON.stringify length, or -1 when the value isn't serializable
 * (circular refs, BigInt, …) — wire input is always JSON, so -1 means
 * an internal caller passed something the store couldn't persist. */
const serializedSize = (value: unknown): number => {
	try {
		return JSON.stringify(value)?.length ?? -1;
	} catch {
		return -1;
	}
};

const sizeIssue = (limit: number): ValidationIssue => ({
	path: "$",
	keyword: "maxLength",
	message: `value exceeds ${limit} bytes serialized`,
});

const parseDefinition = (
	raw: string,
	runId: number,
): Effect.Effect<WizardDefinition, CorruptWizardRun> =>
	Effect.gen(function* () {
		const parsed = parseJson(raw);
		if (parsed === undefined) {
			return yield* Effect.fail(
				new CorruptWizardRun({ runId, reason: "definition_json is not valid JSON" }),
			);
		}
		return yield* Effect.try({
			try: () => assertWizardDefinition(parsed, `wizard run ${runId}`),
			catch: (error) =>
				new CorruptWizardRun({
					runId,
					reason:
						error instanceof Error
							? error.message
							: /* v8 ignore next -- assert* only throws Error */ String(error),
				}),
		});
	});

/** Canonical JSON for def comparison: object keys sorted recursively
 * so two structurally identical defs compare equal regardless of key
 * order (the wire round-trip and manifest authoring order can differ).
 * `__proto__`-style keys become own data properties, never setter
 * hits. */
const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			Object.defineProperty(out, key, {
				value: canonicalize((value as Record<string, unknown>)[key]),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return out;
	}
	return value;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const parseDefRow = (row: WizardDefRow): Effect.Effect<WizardDefinition, InvalidWizardDefinition> =>
	Effect.try({
		try: () => assertWizardDefinition(parseJson(row.definitionJson), `wizard def "${row.key}"`),
		catch: (error) =>
			new InvalidWizardDefinition({
				reason:
					error instanceof Error
						? error.message
						: /* v8 ignore next -- assert* only throws Error */ String(error),
			}),
	});

export class Wizards extends Context.Service<
	Wizards,
	{
		/** Published DB-authored definitions — the public listing the
		 * runner merges with code-contributed defs. */
		readonly publishedDefs: () => Effect.Effect<
			readonly WizardDefAdminRow[],
			InvalidWizardDefinition
		>;
		/** Every DB definition incl. drafts — admin view. */
		readonly adminList: () => Effect.Effect<readonly WizardDefAdminRow[], WizardRunError>;
		/** Insert or update a definition by key; validates the payload. */
		readonly adminUpsert: (
			input: UpsertDefInput,
		) => Effect.Effect<WizardDefAdminRow, WizardRunError>;
		/** Flip the published flag; `WizardDefNotFound` when missing. */
		readonly adminSetPublished: (
			key: string,
			published: boolean,
		) => Effect.Effect<void, WizardRunError>;
		/** Delete a definition by key; `WizardDefNotFound` when missing. */
		readonly adminRemove: (key: string) => Effect.Effect<void, WizardRunError>;

		/** Start a run; resolves + snapshots the definition. */
		readonly startRun: (input: StartRunInput) => Effect.Effect<WizardRunView, WizardRunError>;
		/** Fetch a run owned by the bound principal. */
		readonly getRun: (runId: number) => Effect.Effect<WizardRunView | null, WizardRunError>;
		/** Submit the current step's value and advance. Requires
		 * `WizardHooks` ambient (completion targets may invoke hooks) —
		 * provided by `WizardsServicesLive`. */
		readonly advance: (
			runId: number,
			input: AdvanceInput,
		) => Effect.Effect<WizardRunView, WizardRunError, WizardHooks>;
		/** Move to the previous visible step. */
		readonly back: (runId: number) => Effect.Effect<WizardRunView, WizardRunError>;
		/** Mark the run abandoned (terminal). */
		readonly abandon: (runId: number) => Effect.Effect<void, WizardRunError>;
		/** Force-complete an active run: fires the completion target
		 * with whatever answers exist so far. Requires `WizardHooks`
		 * ambient — see `advance`. */
		readonly complete: (runId: number) => Effect.Effect<WizardRunView, WizardRunError, WizardHooks>;
	}
>()("@ktb/wizards/Wizards") {}

export const WizardsLive = Layer.effect(
	Wizards,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const requireAdmin = platformAdmin.requireAdmin();
		// Code-contributed defs — the allowlist client-supplied
		// definitions must match (see startRun). Provided by app-host
		// core next to the other *Definitions registries.
		const contributed = yield* WizardDefinitions;
		// Permissions is an OPTIONAL port (rbac plugin may be disabled
		// or ordered later): a def declaring `permission` fails closed
		// without it — same contract as @ktb/flows.
		const permissions = yield* Effect.serviceOption(Permissions);
		// PluginStates is likewise OPTIONAL: when bound, contributed
		// defs owned by disabled plugins are not honored at startRun —
		// runtime enablement, same contract as @ktb/views/@ktb/api.
		const pluginStates = yield* Effect.serviceOption(PluginStates);

		const now = () => new Date();

		const defByKey = (key: string) =>
			Effect.promise(() =>
				db.select().from(wizardDefs).where(eq(wizardDefs.key, key)).limit(1),
			).pipe(Effect.map((rows) => rows[0]));

		const requireOwner = (row: WizardRunRow, userId: string | undefined) =>
			userId !== undefined && row.ownerId === userId
				? Effect.void
				: Effect.fail(new RunForbidden({ runId: row.id }));

		const loadRun = (runId: number) =>
			Effect.gen(function* () {
				const rows = yield* Effect.promise(() =>
					db.select().from(wizardRuns).where(eq(wizardRuns.id, runId)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) {
					return yield* Effect.fail(new WizardRunNotFound({ runId }));
				}
				const principal = yield* Principal;
				yield* requireOwner(row, principal?.userId);
				return row;
			});

		/** resolution is narrowed: "invalid" positions already failed
		 * above as CorruptWizardRun. */
		type LiveResolution = Exclude<StepResolution, { kind: "invalid" }>;

		/** Parsed definition snapshots keyed by the raw definition_json —
		 * every run op used to re-parse + re-validate the same immutable
		 * snapshot. Bounded FIFO; defs are small JSON docs. */
		const DEFINITION_CACHE_LIMIT = 100;
		const definitionCache = new Map<string, WizardDefinition>();
		const parseDefinitionCached = (raw: string, runId: number) =>
			Effect.suspend(() => {
				const cached = definitionCache.get(raw);
				if (cached !== undefined) return Effect.succeed(cached);
				return parseDefinition(raw, runId).pipe(
					Effect.map((definition) => {
						if (definitionCache.size >= DEFINITION_CACHE_LIMIT) {
							// FIFO eviction — Map iteration is insertion-
							// ordered; at the cap the map is never empty.
							definitionCache.delete(definitionCache.keys().next().value as string);
						}
						definitionCache.set(raw, definition);
						return definition;
					}),
				);
			});

		const resolutionOf = (
			row: WizardRunRow,
		): Effect.Effect<
			{
				definition: WizardDefinition;
				answers: Record<string, unknown>;
				resolution: LiveResolution;
			},
			CorruptWizardRun
		> =>
			Effect.gen(function* () {
				const definition = yield* parseDefinitionCached(row.definitionJson, row.id);
				const answers = yield* parseAnswers(row.answersJson, row.id);
				const resolution = resolveCurrentStep(definition, {
					stepIndex: row.stepIndex,
					answers,
				});
				if (resolution.kind === "invalid") {
					return yield* Effect.fail(
						new CorruptWizardRun({ runId: row.id, reason: resolution.reason }),
					);
				}
				return { definition, answers, resolution };
			});

		const toView = (row: WizardRunRow): Effect.Effect<WizardRunView, CorruptWizardRun> =>
			Effect.gen(function* () {
				const { definition, answers, resolution } = yield* resolutionOf(row);
				const status = asStatus(row.status);
				if (status !== "active" || resolution.kind !== "step") {
					return {
						id: row.id,
						key: row.key,
						status,
						definition,
						step: null,
						stepIndex: -1,
						canGoBack: false,
						isLastStep: false,
						answers,
					};
				}
				return {
					id: row.id,
					key: row.key,
					status,
					definition,
					step: resolution.step,
					stepIndex: resolution.index,
					canGoBack: previousVisibleIndex(definition, resolution.index, answers) !== null,
					isLastStep: nextVisibleIndex(definition, resolution.index, answers) === null,
					answers,
				};
			});

		/** Optimistic-concurrency update: only applies while the row
		 * still matches the status/position/answers we read. A concurrent
		 * advance/back/abandon that landed first makes this a no-op →
		 * `WizardRunConflict` instead of a lost update. */
		const updateRunGuarded = (
			row: WizardRunRow,
			patch: Partial<typeof wizardRuns.$inferInsert>,
		): Effect.Effect<WizardRunRow, WizardRunConflict> =>
			Effect.promise(() =>
				db
					.update(wizardRuns)
					.set({ ...patch, updatedAt: now() })
					.where(
						and(
							eq(wizardRuns.id, row.id),
							eq(wizardRuns.status, "active"),
							eq(wizardRuns.stepIndex, row.stepIndex),
							eq(wizardRuns.answersJson, row.answersJson),
						),
					)
					.returning(),
			).pipe(
				Effect.flatMap((rows) => {
					const updated = rows[0];
					/* v8 ignore next 3 -- only a concurrent mutation can
					 * empty the optimistic guard; single effects can't
					 * interleave mid-update in tests */
					if (updated === undefined) {
						return Effect.fail(new WizardRunConflict({ runId: row.id }));
					}
					return Effect.succeed(updated);
				}),
			);

		/** A `completing` claim older than this is presumed crashed —
		 * the next run op reverts it to `active` so the run isn't
		 * bricked. Generously above any sane completion duration; the
		 * cost of a wrong guess is one duplicate completion fire
		 * (at-least-once, documented on the service). */
		const COMPLETION_CLAIM_STALE_MS = 5 * 60 * 1000;

		/** Self-healing read: a stale `completing` row (crashed mid-
		 * completion) reverts to `active` exactly once — the conditional
		 * update pins the observed `updatedAt` so a fresh claim can't
		 * be clobbered. Fresh `completing` rows pass through and fail
		 * the caller's `status !== "active"` check. */
		const recoverStaleClaim = (row: WizardRunRow): Effect.Effect<WizardRunRow> => {
			if (row.status !== "completing") return Effect.succeed(row);
			if (now().getTime() - row.updatedAt.getTime() <= COMPLETION_CLAIM_STALE_MS) {
				return Effect.succeed(row);
			}
			return Effect.promise(() =>
				db
					.update(wizardRuns)
					.set({ status: "active", updatedAt: now() })
					.where(
						and(
							eq(wizardRuns.id, row.id),
							eq(wizardRuns.status, "completing"),
							eq(wizardRuns.updatedAt, row.updatedAt),
						),
					)
					.returning(),
			).pipe(
				Effect.map((rows) => {
					const recovered = rows[0];
					/* v8 ignore next -- a concurrent op may have already
					 * reverted the claim between our read and update */
					return recovered ?? row;
				}),
			);
		};

		/** Persist answers/position through the guarded update, then —
		 * when the interpreter reports done — CLAIM the run
		 * (`active → completing`, single-flight) BEFORE firing the
		 * completion target, and close it (`completing → completed`)
		 * only after the target succeeds. A completion failure reverts
		 * the claim to `active` so the next advance/complete retries;
		 * the claim ordering means the status write can't fail after
		 * the side-effect already fired (no re-fire on write failure). */
		const finalizeIfDone = (
			row: WizardRunRow,
			definition: WizardDefinition,
			answers: Record<string, unknown>,
			position: number,
		): Effect.Effect<WizardRunRow, WizardRunError, WizardHooks> =>
			Effect.gen(function* () {
				const answersJson = JSON.stringify(answers);
				const updated = yield* updateRunGuarded(row, {
					stepIndex: position,
					answersJson,
				});
				const after = resolveCurrentStep(definition, { stepIndex: position, answers });
				if (after.kind !== "done") return updated;
				// Claim: exactly one concurrent finisher flips the row to
				// 'completing' — the loser sees 0 rows → WizardRunConflict.
				const claimed = yield* Effect.promise(() =>
					db
						.update(wizardRuns)
						.set({ status: "completing", updatedAt: now() })
						.where(
							and(
								eq(wizardRuns.id, updated.id),
								eq(wizardRuns.status, "active"),
								eq(wizardRuns.stepIndex, position),
								eq(wizardRuns.answersJson, answersJson),
							),
						)
						.returning(),
				);
				/* v8 ignore next 3 -- the guarded persist above just wrote
				 * this exact state while status was 'active'; only a
				 * concurrent writer (untestable single-threaded) can make
				 * the claim miss */
				if (claimed[0] === undefined) {
					return yield* Effect.fail(new WizardRunConflict({ runId: row.id }));
				}
				const fired = yield* Effect.exit(
					runCompletion(definition.completion, {
						run: { id: row.id, key: row.key, ownerId: row.ownerId },
						definition,
						answers,
					}),
				);
				if (Exit.isFailure(fired)) {
					// Revert the claim (best-effort) so a retry re-fires —
					// covers typed failures AND defects.
					yield* Effect.promise(() =>
						db
							.update(wizardRuns)
							.set({ status: "active", updatedAt: now() })
							.where(and(eq(wizardRuns.id, updated.id), eq(wizardRuns.status, "completing"))),
					).pipe(Effect.ignore);
					return yield* Effect.failCause(fired.cause);
				}
				const finished = yield* Effect.promise(() =>
					db
						.update(wizardRuns)
						.set({ status: "completed", completedAt: now(), updatedAt: now() })
						.where(and(eq(wizardRuns.id, updated.id), eq(wizardRuns.status, "completing")))
						.returning(),
				);
				const finishedRow = finished[0];
				/* v8 ignore next 3 -- the claim is seconds old here; only a
				 * stale-claim recovery (5min) could have stolen the row */
				if (finishedRow === undefined) {
					return yield* Effect.fail(new WizardRunConflict({ runId: row.id }));
				}
				return finishedRow;
			});

		const toAdminRow = (
			row: WizardDefRow,
		): Effect.Effect<WizardDefAdminRow, InvalidWizardDefinition> =>
			Effect.gen(function* () {
				const definition = yield* parseDefRow(row);
				return {
					key: row.key,
					title: row.title,
					description: row.description,
					definition,
					published: row.published,
					updatedAt: row.updatedAt,
				};
			});

		/** Optional permission gate — checked before the run row is
		 * written so a denied caller learns nothing. Fails closed when
		 * the def declares `permission` but no Permissions service is
		 * bound (rbac plugin disabled/absent). */
		const authorizeDefinition = (
			definition: WizardDefinition,
		): Effect.Effect<void, WizardPermissionDenied> => {
			const permission = definition.permission;
			if (permission === undefined) return Effect.void;
			if (Option.isNone(permissions)) {
				return Effect.fail(new WizardPermissionDenied({ key: definition.id, permission }));
			}
			const { resource, action } = splitPermission(permission);
			// P-084: wizard runs write tenant-scoped document data, so the
			// grant check binds the ambient tenant under "strict" —
			// global (tenant_id NULL) grants do not bleed in. No bound
			// Tenant → tenant-less check, global grants only.
			return Effect.gen(function* () {
				const scopeId = tenantScopeId(yield* Tenant);
				const allowed = yield* permissions.value.can(resource, action, {
					tenantId: scopeId ?? undefined,
					tenantPolicy: "strict",
				});
				if (!allowed) {
					return yield* Effect.fail(new WizardPermissionDenied({ key: definition.id, permission }));
				}
			});
		};

		return Wizards.of({
			publishedDefs: Effect.fn("Wizards.publishedDefs")(function* () {
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(wizardDefs)
						.where(eq(wizardDefs.published, true))
						.orderBy(asc(wizardDefs.key)),
				);
				return yield* Effect.forEach(rows, toAdminRow);
			}),

			adminList: Effect.fn("Wizards.adminList")(function* () {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(wizardDefs).orderBy(asc(wizardDefs.key)),
				);
				return yield* Effect.forEach(rows, toAdminRow);
			}),

			adminUpsert: Effect.fn("Wizards.adminUpsert")(function* (input: UpsertDefInput) {
				yield* requireAdmin;
				if (!WIZARD_ID_PATTERN.test(input.key)) {
					return yield* Effect.fail(
						new InvalidWizardDefinition({
							reason: `wizard key must match ${WIZARD_ID_PATTERN} (got ${JSON.stringify(input.key)})`,
						}),
					);
				}
				const definition = yield* Effect.try({
					try: () => assertWizardDefinition(input.definition, `wizard "${input.key}"`),
					catch: (error) =>
						new InvalidWizardDefinition({
							reason:
								error instanceof Error
									? error.message
									: /* v8 ignore next -- assert* only throws Error */ String(error),
						}),
				});
				if (definition.id !== input.key) {
					return yield* Effect.fail(
						new InvalidWizardDefinition({
							reason: `wizard key "${input.key}" does not match definition id "${definition.id}"`,
						}),
					);
				}
				const existing = yield* defByKey(input.key);
				const timestamp = now();
				const values = {
					key: input.key,
					title: input.title,
					description: input.description ?? "",
					definitionJson: JSON.stringify(definition),
					published: input.published ?? existing?.published ?? false,
					updatedAt: timestamp,
				};
				const rows =
					existing === undefined
						? yield* Effect.promise(() =>
								db
									.insert(wizardDefs)
									.values({ ...values, createdAt: timestamp })
									.returning(),
							)
						: yield* Effect.promise(() =>
								db.update(wizardDefs).set(values).where(eq(wizardDefs.key, input.key)).returning(),
							);
				const row = rows[0];
				/* v8 ignore next -- insert/update always return the written row */
				if (row === undefined) {
					return yield* Effect.fail(new WizardDefNotFound({ key: input.key }));
				}
				return yield* toAdminRow(row);
			}),

			adminSetPublished: Effect.fn("Wizards.adminSetPublished")(function* (
				key: string,
				published: boolean,
			) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db
						.update(wizardDefs)
						.set({ published, updatedAt: now() })
						.where(eq(wizardDefs.key, key))
						.returning({ key: wizardDefs.key }),
				);
				if (rows.length === 0) {
					return yield* Effect.fail(new WizardDefNotFound({ key }));
				}
			}),

			adminRemove: Effect.fn("Wizards.adminRemove")(function* (key: string) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(wizardDefs).where(eq(wizardDefs.key, key)).returning({ key: wizardDefs.key }),
				);
				if (rows.length === 0) {
					return yield* Effect.fail(new WizardDefNotFound({ key }));
				}
			}),

			startRun: Effect.fn("Wizards.startRun")(function* (input: StartRunInput) {
				const principal = yield* Principal;
				if (principal === null || principal === undefined) {
					return yield* Effect.fail(new Forbidden({ path: "wizards.run" }));
				}
				if (!WIZARD_ID_PATTERN.test(input.key)) {
					return yield* Effect.fail(
						new InvalidWizardDefinition({
							reason: `wizard key must match ${WIZARD_ID_PATTERN} (got ${JSON.stringify(input.key)})`,
						}),
					);
				}
				const existing = yield* defByKey(input.key);
				let definition: WizardDefinition;
				if (existing !== undefined) {
					if (!existing.published) {
						return yield* Effect.fail(new WizardNotPublished({ key: input.key }));
					}
					definition = yield* parseDefRow(existing).pipe(
						Effect.mapError(
							(error) =>
								new InvalidWizardDefinition({
									reason: `stored def "${input.key}": ${error.reason}`,
								}),
						),
					);
				} else {
					definition = yield* Effect.try({
						try: () => assertWizardDefinition(input.definition, `wizard "${input.key}"`),
						catch: (error) =>
							new InvalidWizardDefinition({
								reason:
									error instanceof Error
										? error.message
										: /* v8 ignore next -- assert* only throws Error */ String(error),
							}),
					});
					if (definition.id !== input.key) {
						return yield* Effect.fail(
							new InvalidWizardDefinition({
								reason: `wizard key "${input.key}" does not match definition id "${definition.id}"`,
							}),
						);
					}
					// The client-supplied def must BE a contributed def —
					// canonical-JSON deep equality against the server-side
					// WizardDefinitions registry (key order normalized).
					// Anything else is a forgery: an arbitrary completion
					// target (collection write / hook invocation) smuggled
					// in as "code contribution".
					const contributedDef = contributed.wizards.find((def) => def.id === input.key);
					// Runtime enablement: a def owned by a disabled plugin
					// is not a legitimate contribution — it fails the same
					// ForbiddenWizardDefinition as an unregistered def.
					let contributedLive = contributedDef !== undefined;
					if (contributedDef !== undefined && Option.isSome(pluginStates)) {
						const enabled = yield* pluginStates.value.enabledIds();
						contributedLive = defOwnerEnabled(
							contributed.ownerIndex,
							contributedDef.owner,
							enabled,
						);
					}
					if (
						contributedDef === undefined ||
						!contributedLive ||
						canonicalJson(contributedDef) !== canonicalJson(definition)
					) {
						return yield* Effect.fail(new ForbiddenWizardDefinition({ key: input.key }));
					}
				}
				yield* authorizeDefinition(definition);
				const timestamp = now();
				const rows = yield* Effect.promise(() =>
					db
						.insert(wizardRuns)
						.values({
							key: input.key,
							definitionJson: JSON.stringify(definition),
							status: "active",
							stepIndex: 0,
							answersJson: "{}",
							ownerId: principal.userId,
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.returning(),
				);
				const row = rows[0];
				/* v8 ignore next -- insert always returns the written row */
				if (row === undefined) {
					return yield* Effect.fail(
						new InvalidWizardDefinition({ reason: "run insert returned no row" }),
					);
				}
				return yield* toView(row);
			}),

			getRun: Effect.fn("Wizards.getRun")(function* (runId: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(wizardRuns).where(eq(wizardRuns.id, runId)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) return null;
				const principal = yield* Principal;
				if (principal?.userId !== row.ownerId) {
					return null; // missing and not-owned are indistinguishable
				}
				// Heal a crashed completion claim on read too — a stale
				// 'completing' row would otherwise pin the view forever.
				return yield* toView(yield* recoverStaleClaim(row));
			}),

			advance: Effect.fn("Wizards.advance")(function* (runId: number, input: AdvanceInput) {
				const loaded = yield* loadRun(runId);
				const row = yield* recoverStaleClaim(loaded);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				const { definition, answers, resolution } = yield* resolutionOf(row);
				if (resolution.kind === "done") {
					// Already at the end (e.g. a previous completion failed) —
					// retry the finish rather than demanding a step submit.
					const finished = yield* finalizeIfDone(row, definition, answers, definition.steps.length);
					return yield* toView(finished);
				}
				const current = resolution;
				if (input.stepId !== undefined && input.stepId !== current.step.id) {
					return yield* Effect.fail(
						new StepMismatch({
							runId,
							expected: current.step.id,
							got: input.stepId,
						}),
					);
				}
				if (input.value !== undefined) {
					// Bound the payload BEFORE it touches the store: the
					// serialized value must fit the step-value cap and —
					// for form steps — satisfy the step's JSON schema
					// server-side (the client SchemaForm check is UX,
					// not enforcement).
					const valueSize = serializedSize(input.value);
					if (valueSize < 0 || valueSize > MAX_STEP_VALUE_BYTES) {
						return yield* Effect.fail(
							new InvalidStepValue({
								runId,
								stepId: current.step.id,
								issues: [sizeIssue(MAX_STEP_VALUE_BYTES)],
							}),
						);
					}
					if (current.step.kind === "form") {
						const issues = validate(current.step.schema, input.value);
						if (issues.length > 0) {
							return yield* Effect.fail(
								new InvalidStepValue({ runId, stepId: current.step.id, issues }),
							);
						}
					}
				}
				const merged: Record<string, unknown> = { ...answers };
				if (input.value !== undefined) {
					// defineProperty: a "__proto__" step id must become an
					// own data key, never hit the prototype setter (step
					// ids in that denylist are already rejected by
					// assertWizardDefinition — this is belt & suspenders
					// for defs that skipped assertion).
					Object.defineProperty(merged, current.step.id, {
						value: input.value,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
				// merged is always re-serializable here — answers came from
				// answers_json (JSON by construction) and input.value
				// passed serializedSize above — so only the cap applies.
				if (serializedSize(merged) > MAX_ANSWERS_BYTES) {
					return yield* Effect.fail(
						new InvalidStepValue({
							runId,
							stepId: current.step.id,
							issues: [sizeIssue(MAX_ANSWERS_BYTES)],
						}),
					);
				}
				const position = current.index + 1;
				const finished = yield* finalizeIfDone(row, definition, merged, position);
				return yield* toView(finished);
			}),

			back: Effect.fn("Wizards.back")(function* (runId: number) {
				const loaded = yield* loadRun(runId);
				const row = yield* recoverStaleClaim(loaded);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				const { definition, answers, resolution } = yield* resolutionOf(row);
				// "done" positions (active run parked at the end) scan back
				// from the end of the step list.
				const from = resolution.kind === "step" ? resolution.index : definition.steps.length;
				const prev = previousVisibleIndex(definition, from, answers);
				if (prev === null) return yield* toView(row);
				const updated = yield* updateRunGuarded(row, { stepIndex: prev });
				return yield* toView(updated);
			}),

			abandon: Effect.fn("Wizards.abandon")(function* (runId: number) {
				const loaded = yield* loadRun(runId);
				const row = yield* recoverStaleClaim(loaded);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				yield* updateRunGuarded(row, { status: "abandoned", completedAt: now() });
			}),

			complete: Effect.fn("Wizards.complete")(function* (runId: number) {
				const loaded = yield* loadRun(runId);
				const row = yield* recoverStaleClaim(loaded);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				const { definition, answers } = yield* resolutionOf(row);
				const finished = yield* finalizeIfDone(row, definition, answers, definition.steps.length);
				return yield* toView(finished);
			}),
		});
	}),
);

/** The services-layer export: Wizards + the shared WizardHooks
 * registry other plugins register completion handlers on. */
export const WizardsServicesLive = Layer.merge(WizardsLive, WizardHooksLive);

export const WIZARDS_TEST_DDL = `
CREATE TABLE wizard_defs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	definition_json TEXT NOT NULL,
	published INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX wizard_defs_key_idx ON wizard_defs (key);
CREATE TABLE wizard_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key TEXT NOT NULL,
	definition_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	step_index INTEGER NOT NULL DEFAULT 0,
	answers_json TEXT NOT NULL DEFAULT '{}',
	owner_id TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER
);
CREATE INDEX wizard_runs_owner_idx ON wizard_runs (owner_id, status);
`;
