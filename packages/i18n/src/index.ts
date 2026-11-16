export {
	parseMessage,
	paramSignature,
	renderMessage,
	validateAgainstSignature,
	type MessageKind,
	type MessageParam,
	type ParamHint,
	type ParsedMessage,
	type ParseResult,
	type ValidationIssue,
} from "./message.ts";
export {
	GLOBAL_SCOPE,
	indexMessages,
	localeChain,
	portalScope,
	resolveMessage,
	resolveRequestLocales,
	tenantScope,
	type EnabledLocale,
	type LocaleChain,
	type MessageRow,
	type MessageScope,
	type ResolvedMessage,
	type ScopeChain,
} from "./resolve.ts";
export { createCatalogT, sliceMessages } from "./catalog.ts";
export { I18n, bindNamespace, type I18nShape, type TParams } from "./service.ts";
export { I18N_BASE_CATALOG, I18N_BASE_LOCALES, I18N_MANIFEST } from "./manifest.gen.ts";
export type { I18nKey, I18nTypedT } from "./types.gen.ts";
