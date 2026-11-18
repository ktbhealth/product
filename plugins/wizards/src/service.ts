import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { asc, eq } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { runCompletion, type CompletionFailed } from "./completion.ts";
import {
	assertWizardDefinition,
	WIZARD_ID_PATTERN,
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
 * Otherwise the client-supplied definition is validated and its `id`
 * must equal the requested key — this is the code-contribution path
 * (`wizard.def` entries are client-registry data the server cannot
 * enumerate, same constraint as `form.def`). Runs snapshot the
 * resolved definition into `definition_json`, so later def edits
 * never mutate an in-flight run.
 *
 * Runs are private to their owner (`owner_id` = bound Principal
 * userId); every run method re-checks ownership inside the service —
 * defense in depth behind the session-gated server fns. Completion
 * failures fail `advance`/`complete` AFTER the answers are persisted,
 * so a retry re-enters the done-state and re-fires the target.
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

const parseAnswers = (raw: string): Record<string, unknown> => {
	const parsed = parseJson(raw);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
};

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
				const definition = yield* parseDefinition(row.definitionJson, row.id);
				const answers = parseAnswers(row.answersJson);
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

		const updateRun = (
			row: WizardRunRow,
			patch: Partial<typeof wizardRuns.$inferInsert>,
		): Effect.Effect<WizardRunRow> =>
			Effect.promise(() =>
				db
					.update(wizardRuns)
					.set({ ...patch, updatedAt: now() })
					.where(eq(wizardRuns.id, row.id))
					.returning(),
			).pipe(
				Effect.map(
					/* v8 ignore next -- update().returning() always yields the row */
					(rows) => rows[0] ?? row,
				),
			);

		/** Persist answers/position, then — when the interpreter reports
		 * done — fire the completion target and close the run. A
		 * CompletionFailed leaves the row active at the done position so
		 * the next advance/complete retries the target. */
		const finalizeIfDone = (
			row: WizardRunRow,
			definition: WizardDefinition,
			answers: Record<string, unknown>,
			position: number,
		): Effect.Effect<WizardRunRow, WizardRunError, WizardHooks> =>
			Effect.gen(function* () {
				const updated = yield* updateRun(row, {
					stepIndex: position,
					answersJson: JSON.stringify(answers),
				});
				const after = resolveCurrentStep(definition, { stepIndex: position, answers });
				if (after.kind !== "done") return updated;
				yield* runCompletion(definition.completion, {
					run: { id: row.id, key: row.key, ownerId: row.ownerId },
					definition,
					answers,
				});
				return yield* updateRun(updated, {
					status: "completed",
					completedAt: now(),
				});
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
				}
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
				return yield* toView(row);
			}),

			advance: Effect.fn("Wizards.advance")(function* (runId: number, input: AdvanceInput) {
				const row = yield* loadRun(runId);
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
				const merged: Record<string, unknown> = { ...answers };
				if (input.value !== undefined) merged[current.step.id] = input.value;
				const position = current.index + 1;
				const finished = yield* finalizeIfDone(row, definition, merged, position);
				return yield* toView(finished);
			}),

			back: Effect.fn("Wizards.back")(function* (runId: number) {
				const row = yield* loadRun(runId);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				const { definition, answers, resolution } = yield* resolutionOf(row);
				// "done" positions (active run parked at the end) scan back
				// from the end of the step list.
				const from = resolution.kind === "step" ? resolution.index : definition.steps.length;
				const prev = previousVisibleIndex(definition, from, answers);
				if (prev === null) return yield* toView(row);
				const updated = yield* updateRun(row, { stepIndex: prev });
				return yield* toView(updated);
			}),

			abandon: Effect.fn("Wizards.abandon")(function* (runId: number) {
				const row = yield* loadRun(runId);
				if (row.status !== "active") {
					return yield* Effect.fail(new WizardNotActive({ runId, status: row.status }));
				}
				yield* updateRun(row, { status: "abandoned", completedAt: now() });
			}),

			complete: Effect.fn("Wizards.complete")(function* (runId: number) {
				const row = yield* loadRun(runId);
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
