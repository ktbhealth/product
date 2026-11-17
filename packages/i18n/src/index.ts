export {
	isParametrizedMessage,
	paramMessage,
	parseMessage,
	paramSignature,
	pseudoLocalize,
	renderMessage,
	validateAgainstSignature,
	type MessageKind,
	type MessageParam,
	type ParametrizedMessage,
	type ParamHint,
	type ParsedMessage,
	PSEUDO_LOCALE,
	type ParseResult,
	type ValidationIssue,
} from "./message.ts";
export {
	GLOBAL_SCOPE,
	indexMessages,
	localeChain,
	portalInstanceScope,
	portalScope,
	resolveMessage,
	resolveRow,
	resolveRequestLocales,
	tenantScope,
	type EnabledLocale,
	type LocaleChain,
	type MessageRow,
	type MessageScope,
	type ResolvedMessage,
	type ScopeChain,
} from "./resolve.ts";
export { createCatalogT, flattenCatalog, sliceMessages } from "./catalog.ts";
export { I18n, bindNamespace, type I18nShape, type TParams } from "./service.ts";
// I18N_BASELINE is deliberately NOT re-exported here (P-088): the
// ~24k-line seed dataset must stay out of the worker bundle — consumers
// that need it import the "@ktb/i18n/baseline.gen" subpath so bundlers
// can code-split/lazy-load it.
export { LOCALE_META } from "./locales.ts";
export { I18N_BASE_CATALOG, I18N_BASE_LOCALES, I18N_MANIFEST } from "./manifest.gen.ts";
export type { I18nKey, I18nTypedT } from "./types.gen.ts";
