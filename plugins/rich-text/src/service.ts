import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Forbidden } from "@ktb/authz";
import { defineAdminStore } from "@ktb/admin-store";

import { richText, type RichText } from "./schema.ts";
import { parseRichTextValue } from "./value.ts";

export type { RichText } from "./schema.ts";

/**
 * Rich-text domain service: DB-backed documents edited through the
 * Plate-based `RichTextEditor` in the /platform/rich-text console. Admin
 * methods re-check the `PlatformAdmin` gate inside the service (defense
 * in depth — the panel guard and the server fns gate too);
 * `getById` is the public read used by consumers that render or pick
 * documents (e.g. the pages plugin doc picker) — it needs no principal
 * so anonymous app pages can embed stored content.
 *
 * The list/get/remove/getById core comes from `@ktb/admin-store`'s
 * `defineAdminStore`; the write contract is plugin-owned (`title`
 * instead of `name`, optional title defaulting to "Untitled", `value`
 * seeded with the canonical empty document and validated as Plate
 * JSON), so `writes.create`/`writes.update` carry it — still behind
 * the factory's admin gate and span naming.
 */

/** `adminUpdate` received a `value` that is not a non-empty JSON array —
 * the rejected input is carried for debugging. */
export class InvalidRichTextValue extends Data.TaggedError("InvalidRichTextValue")<{
	readonly value: string;
}> {}

/** `adminUpdate`/`adminRemove` targeted a missing row. Injected into
 * the store as `errors.notFound` so the generated `adminRemove` throws
 * this exact class. */
export class RichTextNotFound extends Data.TaggedError("RichTextNotFound")<{
	readonly id: number;
}> {}

export type RichTextError = Forbidden | RichTextNotFound | InvalidRichTextValue;

/** Admin-facing row without the document payload — list endpoints. */
export interface RichTextMeta {
	readonly id: number;
	readonly title: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Full document: meta plus the parsed Plate value (`null` when the
 * stored JSON is missing/corrupt — the row still lists). */
export interface RichTextDoc extends RichTextMeta {
	readonly content: unknown;
}

/** Canonical empty document — what `adminCreate` seeds and what the
 * editor saves before the user types. */
const EMPTY_DOC = [{ type: "p", children: [{ text: "" }] }] as const;

const toMeta = (row: RichText): RichTextMeta => ({
	id: row.id,
	title: row.title,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toDoc = (row: RichText): RichTextDoc => ({
	...toMeta(row),
	content: parseRichTextValue(row.value),
});

const store = defineAdminStore({
	serviceName: "RichTexts",
	table: richText,
	columns: { id: richText.id, updatedAt: richText.updatedAt },
	// `value` is the payload column for error-tag purposes; the
	// generated writes never run (both are custom), so
	// payloadField/defaultPayload/naturalKey stay unset. The
	// invalidName/nameTaken/invalidPayload slots are unused decoys.
	payloadField: "value",
	errors: {
		notFound: RichTextNotFound,
		invalidName: "InvalidRichTextName",
		nameTaken: "RichTextNameTaken",
		invalidPayload: "InvalidRichTextValue",
	},
	toMeta,
	toDoc,
	writes: {
		// Annotated (though infallible) so the method's error channel is
		// the plugin union, not the generated-write fallback.
		create: (
			input: { readonly title?: string },
			ctx,
		): Effect.Effect<RichTextDoc | null, RichTextError> =>
			Effect.gen(function* () {
				const rows = yield* Effect.promise(() =>
					ctx.db
						.insert(richText)
						.values({
							title: input.title?.trim() || "Untitled",
							value: JSON.stringify(EMPTY_DOC),
							createdAt: new Date(),
							updatedAt: new Date(),
						})
						.returning(),
				);
				const row = rows[0];
				/* v8 ignore next -- sqlite insert .returning() always yields the row */
				return row === undefined ? null : toDoc(row);
			}),
		update: (id: number, input: { readonly title?: string; readonly value?: string }, ctx) =>
			Effect.gen(function* () {
				let valueJson: string | undefined;
				if (input.value !== undefined) {
					if (parseRichTextValue(input.value) === null) {
						return yield* new InvalidRichTextValue({ value: input.value });
					}
					valueJson = input.value;
				}
				const set: {
					title?: string;
					value?: string;
					updatedAt: Date;
				} = { updatedAt: new Date() };
				if (input.title !== undefined) set.title = input.title;
				if (valueJson !== undefined) set.value = valueJson;
				const rows = yield* Effect.promise(() =>
					ctx.db.update(richText).set(set).where(ctx.byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new RichTextNotFound({ id });
				return toDoc(row);
			}),
	},
});

/** The service shape — exported so the element-kind declaration
 * (./kind.tsx) can type its services record via `import type` without
 * pulling this server module into the client bundle. */
export interface RichTextsShape {
	/** Every document, most recently updated first — meta only. */
	readonly adminList: () => Effect.Effect<readonly RichTextMeta[], Forbidden>;
	/** One document by id (parsed content); null when missing. */
	readonly adminGet: (id: number) => Effect.Effect<RichTextDoc | null, RichTextError>;
	/** Insert a document seeded with the canonical empty value;
	 * `null` when the insert returning comes back empty. */
	readonly adminCreate: (input: {
		readonly title?: string;
	}) => Effect.Effect<RichTextDoc | null, RichTextError>;
	/** Update title and/or value by id; `InvalidRichTextValue` when a
	 * supplied `value` is not a non-empty JSON array, `RichTextNotFound`
	 * when the row is missing. */
	readonly adminUpdate: (
		id: number,
		input: { readonly title?: string; readonly value?: string },
	) => Effect.Effect<RichTextDoc, RichTextError>;
	/** Delete a document by id; `RichTextNotFound` when missing. */
	readonly adminRemove: (id: number) => Effect.Effect<void, RichTextError>;
	/** Public read by id — no admin gate (anonymous consumers render
	 * stored documents); null when missing. */
	readonly getById: (id: number) => Effect.Effect<RichTextDoc | null>;
}

export class RichTexts extends Context.Service<RichTexts, RichTextsShape>()(
	"@ktb/rich-text/RichTexts",
) {}

export const RichTextsLive = Layer.effect(
	RichTexts,
	Effect.gen(function* () {
		const { methods } = yield* store.build;
		return RichTexts.of({ ...methods });
	}),
);
