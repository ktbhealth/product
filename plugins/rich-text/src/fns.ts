import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";
import type { Json } from "effect/Schema";

import { ensureSessionUser, requirePluginEnabled, run, runAs } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";

import { RichTexts, type RichTextDoc, type RichTextMeta } from "./service.ts";

// Rich-text server functions: admin CRUD is PlatformAdmin-gated (the
// /platform layout already 404s non-admins; the service re-checks inside
// runAs — defense in depth, same pattern as the pages plugin). The
// public `richTextDocFn` is session-optional: anonymous app pages may
// embed stored documents, and the owning plugin's enabled state is
// checked via PluginStates so a disabled plugin can't leak content.
// Handled domain failures (Forbidden / RichTextNotFound /
// InvalidRichTextValue) collapse to null/false/[] — the same "not
// visible / not saved" contract the other plugin fns use; other errors
// still propagate.

/** Serializable document — `content` is the parsed Plate value and
 * `updatedAt` an ISO string so list UIs can format it client-side. */
export interface RichTextDocWire {
	readonly id: number;
	readonly title: string;
	readonly content: Json;
	readonly updatedAt: string;
}

/** List row for consumers that only need identity + freshness. */
export interface RichTextMetaWire {
	readonly id: number;
	readonly title: string;
	readonly updatedAt: string;
}

const toDocWire = (row: RichTextDoc): RichTextDocWire => ({
	id: row.id,
	title: row.title,
	content: row.content as Json,
	updatedAt: row.updatedAt.toISOString(),
});

const toMetaWire = (row: RichTextMeta): RichTextMetaWire => ({
	id: row.id,
	title: row.title,
	updatedAt: row.updatedAt.toISOString(),
});

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

const CreateInput = Schema.Struct({ title: Schema.optionalKey(Schema.String) });
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	title: Schema.optionalKey(Schema.String),
	value: Schema.optionalKey(Schema.String),
});
const IdInput = Schema.Struct({ id: Schema.Number });

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

const HANDLED_TAGS = ["Forbidden", "RichTextNotFound", "InvalidRichTextValue"] as const;

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(HANDLED_TAGS as readonly string[]).includes(String((error as { _tag?: unknown })._tag));

/** Create a document (empty value, optional title); `null` for
 * non-admins and handled domain failures. */
export const createRichTextFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<RichTextDocWire | null> => {
		await requirePluginEnabled("rich-text.panel");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const richTexts = yield* RichTexts;
				const row = yield* richTexts.adminCreate(data);
				return row === null ? null : toDocWire(row);
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
	});

/** Update a document's title and/or value; `null` for non-admins,
 * missing rows, invalid JSON values and other handled failures. */
export const updateRichTextFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(async ({ data }): Promise<RichTextDocWire | null> => {
		await requirePluginEnabled("rich-text.panel");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const richTexts = yield* RichTexts;
				const { id, ...input } = data;
				return toDocWire(yield* richTexts.adminUpdate(id, input));
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
	});

/** Delete a document by id; `false` for non-admins and missing rows. */
export const deleteRichTextFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<boolean> => {
		await requirePluginEnabled("rich-text.panel");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const richTexts = yield* RichTexts;
				yield* richTexts.adminRemove(data.id);
				return true;
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return false;
			throw error;
		});
	});

/** Public document read by id — session-optional (anonymous app pages
 * embed stored documents). Returns null when the plugin is disabled or
 * the row is missing. */
export const richTextDocFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<RichTextDocWire | null> => {
		const enabled = await run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				return yield* states.isEnabled("rich-text.panel");
			}),
		);
		if (!enabled) return null;
		return run(
			Effect.gen(function* () {
				const richTexts = yield* RichTexts;
				const row = yield* richTexts.getById(data.id);
				return row === null ? null : toDocWire(row);
			}),
		);
	});

/** Admin document list for pickers (e.g. the pages plugin doc picker) —
 * id/title/updatedAt only, no content payload. Handled failures
 * collapse to an empty list. */
export const listRichTextDocsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly RichTextMetaWire[]> => {
		await requirePluginEnabled("rich-text.panel");
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const richTexts = yield* RichTexts;
				const rows = yield* richTexts.adminList();
				return rows.map(toMetaWire);
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return [] as readonly RichTextMetaWire[];
			throw error;
		});
	},
);
