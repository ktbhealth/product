import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { Forbidden } from "@ktb/authz";
import type { MessageKind, MessageParam, MessageScope } from "@ktb/i18n";

import type { I18nMessage } from "./schema.ts";
import type { MessageFilter } from "./store.ts";

/**
 * Client-safe contract for the i18n admin surface (PL-008 Phase 3):
 * the `I18nAdmin` tag, wire types and error classes live here so
 * `fns.ts` and panel views can import them without pulling the
 * server graph (Db, Permissions, drizzle) into the browser bundle.
 * The implementation stays in ./admin.ts.
 */

export const I18N_RESOURCE = "i18n";
export const I18N_READ_ACTION = "messages.read";
export const I18N_EDIT_ACTION = "messages.edit";
export const I18N_LOCALES_ACTION = "locales.manage";

export class I18nValidationError extends Data.TaggedError("I18nValidationError")<{
	readonly error: string;
}> {}

export interface MessageId {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: MessageScope;
	readonly scopeId: string;
}

export interface SaveDraftInput extends MessageId {
	readonly kind?: MessageKind;
	readonly value: string;
	/** Declared param signature; defaults to the template's own. */
	readonly params?: readonly MessageParam[];
}

export interface LocaleInfo {
	readonly code: string;
	readonly endonym: string;
	readonly fallbacks: readonly string[];
	readonly enabled: boolean;
}

export interface NamespaceInfo {
	readonly namespace: string;
	readonly pluginId: string;
	readonly defaultLocale: string;
	/** Message rows present for this namespace (any status). */
	readonly messageCount: number;
}

export interface I18nAdminShape {
	readonly namespaces: () => Effect.Effect<readonly NamespaceInfo[], Forbidden>;
	readonly locales: () => Effect.Effect<readonly LocaleInfo[], Forbidden>;
	readonly messages: (filter?: MessageFilter) => Effect.Effect<readonly I18nMessage[], Forbidden>;
	readonly saveDraft: (
		input: SaveDraftInput,
	) => Effect.Effect<void, Forbidden | I18nValidationError>;
	readonly publish: (id: MessageId) => Effect.Effect<void, Forbidden>;
	readonly discardDraft: (id: MessageId) => Effect.Effect<void, Forbidden>;
	readonly setLocaleEnabled: (code: string, enabled: boolean) => Effect.Effect<void, Forbidden>;
	/** Published+draft values for a namespace, grouped by locale —
	 * the panel's export payload. */
	readonly exportNamespace: (namespace: string) => Effect.Effect<I18nExportPayload, Forbidden>;
	/** Validate-then-stage: every entry must parse or NOTHING is
	 * applied. Imported copy lands as drafts, never live. */
	readonly importNamespace: (
		payload: unknown,
	) => Effect.Effect<{ readonly imported: number }, Forbidden | I18nValidationError>;
}

/** Wire format for namespace JSON import/export (PL-008 Phase 3). */
export interface I18nExportPayload {
	readonly version: 1;
	readonly namespace: string;
	readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export class I18nAdmin extends Context.Service<I18nAdmin, I18nAdminShape>()(
	"@ktb/i18n-plugin/I18nAdmin",
) {}
