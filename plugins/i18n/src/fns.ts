import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { getSessionUser, runAs } from "@ktb/server-fns";
import { Forbidden } from "@ktb/authz";

import {
	I18nAdmin,
	MAX_MESSAGE_FIELD_LENGTH,
	MAX_MESSAGE_VALUE_LENGTH,
	type I18nAdminShape,
	type MessageId,
} from "./contract.ts";

/**
 * i18n panel server functions (PL-008 Phase 3). All calls run through
 * `runAs` so the bound Principal feeds audit + rbac grant checks; the
 * I18nAdmin service enforces `i18n.messages.*` permissions (PlatformAdmin
 * allowlist as bootstrap). Denials surface as `{ ok: false }` — same
 * contract as the patients fns.
 */

/** Message-id fields are composite-PRIMARY-KEY material — cap them on
 * the wire like MAX_MESSAGE_VALUE_LENGTH caps values (contract.ts). */
const MessageField = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_FIELD_LENGTH));

const MessageIdInput = Schema.Struct({
	namespace: MessageField,
	key: MessageField,
	locale: MessageField,
	scope: Schema.optionalKey(Schema.Literals(["global", "tenant", "portal"])),
	scopeId: Schema.optionalKey(MessageField),
});
const decodeMessageId = Schema.decodeUnknownSync(MessageIdInput);

/** Draft values are message templates — the cap mirrors the admin
 * service's MAX_MESSAGE_VALUE_LENGTH and bounds the wire + CRDT op
 * size long before the row is parsed. */
const SaveDraftInput = Schema.Struct({
	...MessageIdInput.fields,
	kind: Schema.optionalKey(Schema.Literals(["text", "rich"])),
	value: Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_VALUE_LENGTH)),
});
const decodeSaveDraft = Schema.decodeUnknownSync(SaveDraftInput);

const toId = (d: Schema.Schema.Type<typeof MessageIdInput>): MessageId => ({
	namespace: d.namespace,
	key: d.key,
	locale: d.locale,
	scope: d.scope ?? "global",
	scopeId: d.scopeId ?? "",
});

const withAdmin = <A>(
	fn: (admin: I18nAdminShape) => Effect.Effect<A, unknown>,
): Promise<A | { ok: false; error?: string } | null> =>
	getSessionUser().then(async (user) => {
		if (!user) return null;
		try {
			return await runAs(
				user,
				Effect.gen(function* () {
					const admin = yield* I18nAdmin;
					return yield* fn(admin);
				}),
			);
		} catch (error) {
			// Only authorization denials collapse to { ok: false } — DB and
			// other failures must surface as real errors, not "denied".
			if (error instanceof Forbidden) return { ok: false as const };
			throw error;
		}
	});

/** Matrix fetch filter: one namespace, optionally narrowed to a
 * scope + scope id (tenant id / portal instance id). `scopeId` is an
 * exact match — global rows always carry "". */
const NamespaceMessagesInput = Schema.Struct({
	// Non-empty: `input ?? {}` used to decode to an unfiltered dump of
	// every scope's rows — the namespace is the matrix's root filter.
	namespace: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_MESSAGE_FIELD_LENGTH)),
	scope: Schema.optionalKey(Schema.Literals(["global", "tenant", "portal"])),
	scopeId: Schema.optionalKey(MessageField),
});
const decodeNamespaceMessages = Schema.decodeUnknownSync(NamespaceMessagesInput);

/** Wire cap on matrix rows — one namespace should never approach this;
 * beyond it the response is truncated rather than streaming the table. */
const NAMESPACE_MESSAGES_MAX_ROWS = 10_000;

/**
 * All rows (every locale, status) for ONE namespace — the panel
 * matrix fetches per selected namespace + scope instead of dragging
 * the whole table into loader data. Denied → { ok: false }.
 */
export const i18nNamespaceMessagesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeNamespaceMessages(input ?? {}))
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin
				.messages({
					namespace: data.namespace,
					scope: data.scope,
					scopeId: data.scopeId,
				})
				.pipe(Effect.map((rows) => rows.slice(0, NAMESPACE_MESSAGES_MAX_ROWS))),
		),
	);

export const i18nSaveDraftFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSaveDraft(input))
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin
				.saveDraft({
					namespace: data.namespace,
					key: data.key,
					locale: data.locale,
					scope: data.scope ?? "global",
					scopeId: data.scopeId ?? "",
					kind: data.kind,
					value: data.value,
				})
				.pipe(
					Effect.as({ ok: true as const }),
					Effect.catchTag("I18nValidationError", (e) =>
						Effect.succeed({ ok: false as const, error: e.error }),
					),
					Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
				),
		),
	);

export const i18nPublishFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeMessageId(input))
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.publish(toId(data)).pipe(
				Effect.as({ ok: true as const }),
				Effect.catchTag("I18nValidationError", (e) =>
					Effect.succeed({ ok: false as const, error: e.error }),
				),
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);

export const i18nDiscardDraftFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeMessageId(input))
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.discardDraft(toId(data)).pipe(
				Effect.as({ ok: true as const }),
				Effect.catchTag("I18nValidationError", (e) =>
					Effect.succeed({ ok: false as const, error: e.error }),
				),
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);

export const i18nExportFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(MessageField)(input))
	.handler(({ data: namespace }) => withAdmin((admin) => admin.exportNamespace(namespace)));

/** Wire caps for namespace imports — the payload shape itself is
 * validated inside I18nAdmin.importNamespace (nothing partially
 * applies on bad input), but an unbounded body would be parsed and
 * walked before that check runs. */
const IMPORT_MAX_BYTES = 1_000_000;
// Chunked upserts make large imports cheap, but keep the entry cap
// conservative — validation still walks every entry before any write.
const IMPORT_MAX_ENTRIES = 2_000;

const importPayloadWithinLimits = (payload: unknown): boolean => {
	try {
		if (JSON.stringify(payload).length > IMPORT_MAX_BYTES) return false;
	} catch {
		// Unserializable (e.g. circular) — the service would reject it
		// anyway; fail closed here instead of throwing in the validator.
		return false;
	}
	if (payload === null || typeof payload !== "object") return true;
	const messages = (payload as { readonly messages?: unknown }).messages;
	if (messages === null || typeof messages !== "object") return true;
	let entries = 0;
	for (const kv of Object.values(messages)) {
		if (kv !== null && typeof kv === "object") {
			entries += Object.keys(kv).length;
			if (entries > IMPORT_MAX_ENTRIES) return false;
		}
	}
	return true;
};

export const i18nImportFn = createServerFn({ method: "POST" })
	// Payload shape is validated inside I18nAdmin.importNamespace —
	// nothing partially applies on bad input.
	.validator((input: unknown) => input)
	.handler(({ data }) =>
		withAdmin((admin) =>
			importPayloadWithinLimits(data)
				? admin.importNamespace(data).pipe(
						Effect.map((r) => ({ ok: true as const, imported: r.imported })),
						Effect.catchTag("I18nValidationError", (e) =>
							Effect.succeed({ ok: false as const, error: e.error }),
						),
						Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
					)
				: Effect.succeed({ ok: false as const, error: "import payload too large" }),
		),
	);

export const i18nSetLocaleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		Schema.decodeUnknownSync(Schema.Struct({ code: MessageField, enabled: Schema.Boolean }))(input),
	)
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.setLocaleEnabled(data.code, data.enabled).pipe(
				Effect.as({ ok: true as const }),
				Effect.catchTag("I18nValidationError", (e) =>
					Effect.succeed({ ok: false as const, error: e.error }),
				),
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);
