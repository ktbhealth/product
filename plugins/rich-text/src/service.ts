import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { desc, eq } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

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
 */

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export class RichTextNotFound extends Data.TaggedError("RichTextNotFound")<{
	readonly id: number;
}> {}

/** `adminUpdate` received a `value` that is not a non-empty JSON array —
 * the rejected input is carried for debugging. */
export class InvalidRichTextValue extends Data.TaggedError("InvalidRichTextValue")<{
	readonly value: string;
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
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(richText.id, id);

		return RichTexts.of({
			adminList: Effect.fn("RichTexts.adminList")(function* () {
				yield* requireAdmin;
				return yield* Effect.promise(() =>
					db
						.select({
							id: richText.id,
							title: richText.title,
							createdAt: richText.createdAt,
							updatedAt: richText.updatedAt,
						})
						.from(richText)
						.orderBy(desc(richText.updatedAt)),
				);
			}),
			adminGet: Effect.fn("RichTexts.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(richText).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			adminCreate: Effect.fn("RichTexts.adminCreate")(function* (input: {
				readonly title?: string;
			}) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db
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
				return row === undefined ? null : toDoc(row);
			}),
			adminUpdate: Effect.fn("RichTexts.adminUpdate")(function* (
				id: number,
				input: { readonly title?: string; readonly value?: string },
			) {
				yield* requireAdmin;
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
					db.update(richText).set(set).where(byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new RichTextNotFound({ id });
				return toDoc(row);
			}),
			adminRemove: Effect.fn("RichTexts.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(richText).where(byId(id)).returning({ id: richText.id }),
				);
				if (rows.length === 0) return yield* new RichTextNotFound({ id });
			}),
			getById: Effect.fn("RichTexts.getById")(function* (id: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(richText).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
		});
	}),
);
