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

/**
 * Write-path validation shared by I18nAdmin and baseline sync. Ids are
 * composite-PRIMARY-KEY material, so whitespace/control characters are
 * refused outright; values are length-capped, and rich-kind templates
 * get a defense-in-depth copy of parseMessage's forbidden-markup guard
 * (packages/i18n/src/message.ts RICH_FORBIDDEN_RE) so a parser
 * regression can't write active markup into drafts.
 */
export const MESSAGE_ID_FORBIDDEN_RE = /[\s\x00-\x1f]/;
export const MAX_MESSAGE_VALUE_LENGTH = 50_000;
/** Cap on message-id fields (namespace/key/locale/scopeId) — they are
 * composite-PRIMARY-KEY material, so an unbounded string would let a
 * caller stuff arbitrarily large values into index columns. */
export const MAX_MESSAGE_FIELD_LENGTH = 200;
export const RICH_FORBIDDEN_RE =
	/<\s*(?:script|iframe|object|embed|style)\b|\bon\w+\s*=|javascript\s*:/i;

const MESSAGE_SCOPES: ReadonlySet<string> = new Set(["global", "tenant", "portal"]);

/** Null when the id is well-formed; an error string otherwise. */
export const validateMessageId = (id: {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: string;
	readonly scopeId: string;
}): string | null => {
	if (!MESSAGE_SCOPES.has(id.scope)) return `unknown scope '${id.scope}'`;
	for (const [field, value] of [
		["namespace", id.namespace],
		["key", id.key],
		["locale", id.locale],
	] as const) {
		if (value === "" || MESSAGE_ID_FORBIDDEN_RE.test(value)) {
			return `${field} must be non-empty and free of whitespace/control characters`;
		}
		if (value.length > MAX_MESSAGE_FIELD_LENGTH) {
			return `${field} must be at most ${MAX_MESSAGE_FIELD_LENGTH} characters`;
		}
	}
	if (id.scope === "global") {
		return id.scopeId === "" ? null : "scopeId must be empty for global scope";
	}
	if (id.scopeId === "") return "scopeId is required for tenant/portal scope";
	if (id.scopeId.length > MAX_MESSAGE_FIELD_LENGTH) {
		return `scopeId must be at most ${MAX_MESSAGE_FIELD_LENGTH} characters`;
	}
	if (MESSAGE_ID_FORBIDDEN_RE.test(id.scopeId)) {
		return "scopeId must be free of whitespace/control characters";
	}
	return null;
};

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

/** Read input for I18nAdmin.missingKeys — global scope is implied
 * (the key universe is coverage()'s: distinct global keys). */
export interface MissingKeysInput {
	readonly namespace: string;
	readonly locale: string;
}

export interface NamespaceInfo {
	readonly namespace: string;
	readonly pluginId: string;
	readonly defaultLocale: string;
	/** Global-scope message rows present for this namespace (any status). */
	readonly messageCount: number;
}

/** Per-namespace translation coverage across locales (global scope). */
export interface NamespaceCoverage {
	readonly namespace: string;
	readonly pluginId: string;
	readonly defaultLocale: string;
	/** Distinct message keys present in global scope (any status). */
	readonly keyCount: number;
	/** locale code → count of those keys with a published live value. */
	readonly translated: Readonly<Record<string, number>>;
	/** manifest_hash recorded at baseline (re)import — "" when the
	 * namespace was never registered through syncBaseline or predates
	 * hash recording. */
	readonly manifestHash: string;
	/** Contract drift vs the live I18N_MANIFEST:
	 * - "yes" — a hash was recorded and no longer matches the manifest;
	 * - "no" — recorded hash matches the current manifest;
	 * - "unrecorded" — no stored hash, or the namespace has no manifest
	 *   entry at all (DB-only orphan: drift is not applicable). */
	readonly manifestDrift: "yes" | "no" | "unrecorded";
}

export interface I18nAdminShape {
	readonly namespaces: () => Effect.Effect<readonly NamespaceInfo[], Forbidden>;
	readonly coverage: () => Effect.Effect<readonly NamespaceCoverage[], Forbidden>;
	/** Sorted global-scope keys for the namespace that have NO
	 * published row for the locale — the "N missing" drill-down behind
	 * NamespaceCoverage.translated. Same key universe and
	 * published-only predicate as coverage(). */
	readonly missingKeys: (
		input: MissingKeysInput,
	) => Effect.Effect<readonly string[], Forbidden | I18nValidationError>;
	readonly locales: () => Effect.Effect<readonly LocaleInfo[], Forbidden>;
	readonly messages: (filter?: MessageFilter) => Effect.Effect<readonly I18nMessage[], Forbidden>;
	readonly saveDraft: (
		input: SaveDraftInput,
	) => Effect.Effect<void, Forbidden | I18nValidationError>;
	readonly publish: (id: MessageId) => Effect.Effect<void, Forbidden | I18nValidationError>;
	readonly discardDraft: (id: MessageId) => Effect.Effect<void, Forbidden | I18nValidationError>;
	readonly setLocaleEnabled: (
		code: string,
		enabled: boolean,
	) => Effect.Effect<void, Forbidden | I18nValidationError>;
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
