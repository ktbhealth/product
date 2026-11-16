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
	tenantScope,
	type LocaleChain,
	type MessageRow,
	type MessageScope,
	type ResolvedMessage,
	type ScopeChain,
} from "./resolve.ts";
export { I18n, bindNamespace, type I18nShape, type TParams } from "./service.ts";
