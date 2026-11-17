import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";
import type { Json } from "effect/Schema";

import { ensureSessionUser, run, runAs } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";

import { assertWizardDefinition, type WizardDefinition, type WizardStep } from "./definition.ts";
import { Wizards, type WizardDefAdminRow, type WizardRunView } from "./service.ts";

export type { WizardRunView };

// Wizards server functions: run lifecycle is session-gated (runs are
// private to their owner — the service re-checks ownership inside
// runAs). Admin definition CRUD is PlatformAdmin-gated (the /platform
// layout already 404s non-admins; the service re-checks inside runAs —
// defense in depth, same pattern as the pages/plugin-manager fns).
// Handled domain failures collapse to null/false — the same "not
// visible / not saved" contract the other plugin fns use; other
// errors still propagate.
//
// Wire shapes use `Json`-typed leaves for the definition/step/answers
// payloads (server-fn serialization checks reject the richer
// JsonSchema typings); the client re-validates through
// `defFromWire`/`runViewFromWire` below.

/** Serializable definition row for the admin console + public listing. */
export interface WizardDefWire {
	readonly key: string;
	readonly title: string;
	readonly description: string;
	/** Serialized {@link WizardDefinition} — validate with
	 * `defFromWire`/`assertWizardDefinition` on receipt. */
	readonly definition: Json;
	readonly published: boolean;
	readonly updatedAt: string;
}

/** Serializable run view — same fields as {@link WizardRunView} with
 * JSON-typed payload leaves. */
export interface WizardRunWire {
	readonly id: number;
	readonly key: string;
	readonly status: "active" | "completed" | "abandoned";
	readonly definition: Json;
	readonly step: Json | null;
	readonly stepIndex: number;
	readonly canGoBack: boolean;
	readonly isLastStep: boolean;
	readonly answers: Record<string, Json>;
}

const toDefWire = (row: WizardDefAdminRow): WizardDefWire => ({
	key: row.key,
	title: row.title,
	description: row.description,
	definition: row.definition as unknown as Json,
	published: row.published,
	updatedAt: row.updatedAt.toISOString(),
});

const toRunWire = (view: WizardRunView): WizardRunWire => ({
	id: view.id,
	key: view.key,
	status: view.status,
	definition: view.definition as unknown as Json,
	step: view.step as unknown as Json | null,
	stepIndex: view.stepIndex,
	canGoBack: view.canGoBack,
	isLastStep: view.isLastStep,
	answers: view.answers as Record<string, Json>,
});

/** Re-validate a wire definition payload — returns null on malformed
 * data (defensive: the wire was produced by our own service, so this
 * only guards hand-built/test payloads). */
export const defFromWire = (wire: WizardDefWire | null | undefined): WizardDefinition | null => {
	if (wire === null || wire === undefined) return null;
	try {
		return assertWizardDefinition(wire.definition, `wizard "${wire.key}"`);
	} catch {
		return null;
	}
};

/** Narrow a wire run back to the typed view. Returns null on malformed
 * payloads; `step` rides the already-validated definition's step set. */
export const runViewFromWire = (wire: WizardRunWire | null | undefined): WizardRunView | null => {
	if (wire === null || wire === undefined) return null;
	const definition = defFromWire({
		key: wire.key,
		title: "",
		description: "",
		definition: wire.definition,
		published: true,
		updatedAt: "",
	});
	if (definition === null) return null;
	return {
		id: wire.id,
		key: wire.key,
		status: wire.status,
		definition,
		step: (wire.step ?? null) as WizardStep | null,
		stepIndex: wire.stepIndex,
		canGoBack: wire.canGoBack,
		isLastStep: wire.isLastStep,
		answers: wire.answers as Record<string, unknown>,
	};
};

const HANDLED_TAGS = [
	"Forbidden",
	"InvalidWizardDefinition",
	"WizardDefNotFound",
	"WizardNotPublished",
	"WizardRunNotFound",
	"RunForbidden",
	"WizardNotActive",
	"StepMismatch",
	"CompletionFailed",
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

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
	);

const KeyInput = Schema.Struct({ key: Schema.String });
const RunIdInput = Schema.Struct({ runId: Schema.Number });
const StartInput = Schema.Struct({
	key: Schema.String,
	definition: Schema.optionalKey(Schema.Unknown),
});
const AdvanceInput = Schema.Struct({
	runId: Schema.Number,
	stepId: Schema.optionalKey(Schema.String),
	value: Schema.optionalKey(Schema.Unknown),
});
const UpsertInput = Schema.Struct({
	key: Schema.String,
	title: Schema.String,
	description: Schema.optionalKey(Schema.String),
	definition: Schema.Unknown,
	published: Schema.optionalKey(Schema.Boolean),
});
const PublishInput = Schema.Struct({ key: Schema.String, published: Schema.Boolean });

const decodeKey = Schema.decodeUnknownSync(KeyInput);
const decodeRunId = Schema.decodeUnknownSync(RunIdInput);
const decodeStart = Schema.decodeUnknownSync(StartInput);
const decodeAdvance = Schema.decodeUnknownSync(AdvanceInput);
const decodeUpsert = Schema.decodeUnknownSync(UpsertInput);
const decodePublish = Schema.decodeUnknownSync(PublishInput);

/** Published DB-authored definitions — public read (the runner
 * merges them with code-contributed defs from ctx.plugins). Returns
 * [] on failure so a disabled/broken plugin can't take the page down. */
export const wizardDefsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly WizardDefWire[]> => {
		const rows = await run(
			Effect.gen(function* () {
				const wizards = yield* Wizards;
				return yield* wizards.publishedDefs();
			}),
		).catch(() => [] as readonly WizardDefAdminRow[]);
		return rows.map(toDefWire);
	},
);

/** Start a run. `definition` is required only for code-contributed
 * wizards (no wizard_defs row); DB defs resolve server-side. Returns
 * null for handled failures (bad key/def, unpublished DB def). */
export const startWizardFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeStart(input))
	.handler(async ({ data }): Promise<WizardRunWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return toRunWire(yield* wizards.startRun(data));
				}),
			),
		);
	});

/** Fetch a run — null when missing or not owned (indistinguishable). */
export const getWizardRunFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<WizardRunWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					const view = yield* wizards.getRun(data.runId);
					return view === null ? null : toRunWire(view);
				}),
			),
		);
	});

/** Submit the current step's value and advance (or complete). */
export const advanceWizardFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeAdvance(input))
	.handler(async ({ data }): Promise<WizardRunWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return toRunWire(
						yield* wizards.advance(data.runId, {
							stepId: data.stepId,
							value: data.value,
						}),
					);
				}),
			),
		);
	});

/** Move to the previous visible step. */
export const backWizardFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<WizardRunWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return toRunWire(yield* wizards.back(data.runId));
				}),
			),
		);
	});

/** Abandon the run (terminal). */
export const abandonWizardFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<boolean> => {
		const user = await ensureSessionUser();
		return orFalse(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					yield* wizards.abandon(data.runId);
					return true;
				}),
			),
		);
	});

/** Force-complete an active run (fires the completion target with
 * current answers). */
export const completeWizardFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunId(input))
	.handler(async ({ data }): Promise<WizardRunWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asUser(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return toRunWire(yield* wizards.complete(data.runId));
				}),
			),
		);
	});

// ---------- admin (PlatformAdmin-gated) ----------

/** Every DB definition incl. drafts — admin view. */
export const adminListWizardDefsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly WizardDefWire[]> => {
		const user = await ensureSessionUser();
		return orNull(
			asAdmin(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return (yield* wizards.adminList()).map(toDefWire);
				}),
			),
		).then((rows) => rows ?? []);
	},
);

/** Create/update a definition by key; null for non-admins and
 * handled validation failures. */
export const adminSaveWizardDefFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpsert(input))
	.handler(async ({ data }): Promise<WizardDefWire | null> => {
		const user = await ensureSessionUser();
		return orNull(
			asAdmin(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					return toDefWire(yield* wizards.adminUpsert(data));
				}),
			),
		);
	});

/** Flip the published flag; false for non-admins/missing defs. */
export const adminSetWizardPublishedFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePublish(input))
	.handler(async ({ data }): Promise<boolean> => {
		const user = await ensureSessionUser();
		return orFalse(
			asAdmin(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					yield* wizards.adminSetPublished(data.key, data.published);
					return true;
				}),
			),
		);
	});

/** Delete a definition by key; false for non-admins/missing defs. */
export const adminDeleteWizardDefFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeKey(input))
	.handler(async ({ data }): Promise<boolean> => {
		const user = await ensureSessionUser();
		return orFalse(
			asAdmin(
				user,
				Effect.gen(function* () {
					const wizards = yield* Wizards;
					yield* wizards.adminRemove(data.key);
					return true;
				}),
			),
		);
	});
