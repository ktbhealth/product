import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { getSessionUser, runAs } from "@ktb/server-fns";
import { Forbidden } from "@ktb/authz";

import { I18nAdmin, type I18nAdminShape, type MessageId } from "./contract.ts";

/**
 * i18n panel server functions (PL-008 Phase 3). All calls run through
 * `runAs` so the bound Principal feeds audit + rbac grant checks; the
 * I18nAdmin service enforces `i18n.messages.*` permissions (PlatformAdmin
 * allowlist as bootstrap). Denials surface as `{ ok: false }` — same
 * contract as the patients fns.
 */

const MessageIdInput = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	locale: Schema.String,
	scope: Schema.optionalKey(Schema.Literals(["global", "tenant", "portal"])),
	scopeId: Schema.optionalKey(Schema.String),
});
const decodeMessageId = Schema.decodeUnknownSync(MessageIdInput);

const SaveDraftInput = Schema.Struct({
	...MessageIdInput.fields,
	kind: Schema.optionalKey(Schema.Literals(["text", "rich"])),
	value: Schema.String,
});
const decodeSaveDraft = Schema.decodeUnknownSync(SaveDraftInput);

const NamespaceFilter = Schema.Struct({
	namespace: Schema.optionalKey(Schema.String),
	locale: Schema.optionalKey(Schema.String),
});
const decodeFilter = Schema.decodeUnknownSync(NamespaceFilter);

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

export const i18nNamespacesFn = createServerFn({ method: "GET" }).handler(() =>
	withAdmin((admin) => admin.namespaces()),
);

export const i18nLocalesFn = createServerFn({ method: "GET" }).handler(() =>
	withAdmin((admin) => admin.locales()),
);

export const i18nMessagesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeFilter(input ?? {}))
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.messages({
				namespace: data.namespace,
				locale: data.locale,
				scope: "global",
			}),
		),
	);

/**
 * All rows (every locale, scope and status) for ONE namespace — the
 * panel matrix fetches per selected namespace instead of dragging the
 * whole table into loader data. Denied → { ok: false }.
 */
export const i18nNamespaceMessagesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(Schema.String)(input))
	.handler(({ data: namespace }) => withAdmin((admin) => admin.messages({ namespace })));

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
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);

export const i18nExportFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(Schema.String)(input))
	.handler(({ data: namespace }) => withAdmin((admin) => admin.exportNamespace(namespace)));

export const i18nImportFn = createServerFn({ method: "POST" })
	// Payload shape is validated inside I18nAdmin.importNamespace —
	// nothing partially applies on bad input.
	.validator((input: unknown) => input)
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.importNamespace(data).pipe(
				Effect.as({ ok: true as const }),
				Effect.catchTag("I18nValidationError", (e) =>
					Effect.succeed({ ok: false as const, error: e.error }),
				),
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);

export const i18nSetLocaleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String, enabled: Schema.Boolean }))(
			input,
		),
	)
	.handler(({ data }) =>
		withAdmin((admin) =>
			admin.setLocaleEnabled(data.code, data.enabled).pipe(
				Effect.as({ ok: true as const }),
				Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
			),
		),
	);
