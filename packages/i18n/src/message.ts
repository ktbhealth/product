/**
 * ICU MessageFormat-1 subset — the single parser/renderer/validator for
 * i18n message templates (P-083 / ADR-0003). Pure functions, no I/O.
 *
 * Supported syntax:
 *   {name}                    simple param
 *   {name, number|date|datetime|relative|list}   formatter hint
 *   {name, plural, one{..} other{..} …}          cardinal plural
 *   {name, select, a{..} b{..} …}                select
 *
 * Everything else (rich text tags, nested selects inside params, offsets,
 * exact plural `=N` forms are supported as case keys) — `=N` IS supported
 * as an exact-match case key alongside keyword categories.
 *
 * `text` messages must not contain markup; `rich` messages are sanitized
 * HTML handled by the ui RichTextEditor contract, not this parser.
 */

export type ParamHint = "number" | "date" | "datetime" | "relative" | "list";

export type MessageKind = "text" | "rich";

export interface MessageParam {
	readonly name: string;
	readonly hint?: ParamHint;
	/** plural/select case keys in declaration order (e.g. ["one","other"]). */
	readonly cases?: readonly string[];
	/** true for `plural`, false/undefined for `select`. */
	readonly plural?: boolean;
}

export interface ParsedMessage {
	readonly kind: MessageKind;
	readonly template: string;
	readonly params: readonly MessageParam[];
}

export type ParseResult =
	| { readonly ok: true; readonly message: ParsedMessage }
	| { readonly ok: false; readonly error: string };

export type ValidationIssue =
	| { readonly code: "param_mismatch"; readonly detail: string }
	| { readonly code: "markup_in_text"; readonly detail: string }
	| { readonly code: "unclosed_brace" | "empty_param" | "bad_syntax"; readonly detail: string };

const HINTS: ReadonlySet<string> = new Set(["number", "date", "datetime", "relative", "list"]);
const MARKUP_RE = /<\/?[a-zA-Z][^>]*>/;
/** Defense-in-depth for `rich` templates: active/embed markup and
 * inline event handlers are refused at parse time. Admin-side
 * sanitization (RichTextEditor contract) is the primary control. */
const RICH_FORBIDDEN_RE = /<\s*(?:script|iframe|object|embed|style)\b|\bon\w+\s*=|javascript\s*:/i;
/** Hard bounds so adversarial templates can't blow the stack or CPU:
 * case bodies nest recursively in signature/render/pseudo passes. */
const MAX_TEMPLATE_LENGTH = 10_000;
const MAX_NESTING_DEPTH = 8;

interface Token {
	readonly kind: "text" | "param";
	readonly text?: string;
	readonly name?: string;
	readonly hint?: ParamHint;
	readonly plural?: boolean;
	readonly cases?: ReadonlyArray<{ key: string; body: string }>;
}

/** Find the `}` matching the `{` at `start`, honoring nested braces. */
const matchBrace = (src: string, start: number): number => {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
};

/** Split `src` on top-level commas (depth-0 only). */
const splitTop = (src: string): string[] => {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of src) {
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
};

/** Parse `key{body} key2{body2}` case list inside a plural/select arg. */
const parseCases = (src: string): Array<{ key: string; body: string }> | null => {
	const cases: Array<{ key: string; body: string }> = [];
	let i = 0;
	while (i < src.length) {
		while (i < src.length && /\s/.test(src[i]!)) i++;
		if (i >= src.length) break;
		// case key: keyword or =N
		const m = /^(=\d+|[A-Za-z_]+)\s*/.exec(src.slice(i));
		if (!m) return null;
		const key = m[1]!;
		i += m[0].length;
		if (src[i] !== "{") return null;
		const end = matchBrace(src, i);
		if (end === -1) return null;
		cases.push({ key, body: src.slice(i + 1, end) });
		i = end + 1;
	}
	return cases.length > 0 ? cases : null;
};

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tokenize + parse a template into tokens; null on syntax error. */
const tokenize = (template: string): Token[] | { error: string } => {
	if (template.length > MAX_TEMPLATE_LENGTH) {
		return { error: `template exceeds ${MAX_TEMPLATE_LENGTH} characters` };
	}
	const tokens: Token[] = [];
	let i = 0;
	let textStart = 0;
	const pushText = (end: number) => {
		if (end > textStart) tokens.push({ kind: "text", text: template.slice(textStart, end) });
	};
	while (i < template.length) {
		if (template[i] !== "{") {
			i++;
			continue;
		}
		const end = matchBrace(template, i);
		if (end === -1) return { error: `unclosed '{' at offset ${i}` };
		pushText(i);
		const inner = template.slice(i + 1, end).trim();
		if (inner === "") return { error: "empty {} param" };
		const parts = splitTop(inner).map((p) => p.trim());
		const name = parts[0]!;
		if (!PARAM_NAME_RE.test(name)) return { error: `bad param name '${name}'` };
		const second = parts[1];
		if (second === undefined) {
			tokens.push({ kind: "param", name });
		} else if (HINTS.has(second)) {
			if (parts.length !== 2) return { error: `formatter '${second}' takes no extra args` };
			tokens.push({ kind: "param", name, hint: second as ParamHint });
		} else if (second === "plural" || second === "select") {
			const rest = inner.slice(inner.indexOf(second) + second.length).replace(/^\s*,\s*/, "");
			const cases = parseCases(rest);
			if (!cases) return { error: `bad ${second} cases for '${name}'` };
			tokens.push({ kind: "param", name, plural: second === "plural", cases });
		} else {
			return { error: `unknown param type '${second}' for '${name}'` };
		}
		i = end + 1;
		textStart = i;
	}
	pushText(template.length);
	return tokens;
};

/**
 * Collect the declared param signature, recursing into plural/select
 * case bodies — MF1 allows nested params there (`{a,select,x{{b}}}`),
 * and renderTokens resolves them at render time, so the signature must
 * see them too. Deduped by name, first occurrence wins. Bodies that
 * fail to tokenize are a syntax error; nesting past
 * MAX_NESTING_DEPTH is rejected.
 */
const collectSignature = (tokens: readonly Token[]): MessageParam[] | { error: string } => {
	const params: MessageParam[] = [];
	const seen = new Set<string>();
	const visit = (toks: readonly Token[], depth: number): string | null => {
		for (const t of toks) {
			if (t.kind !== "param" || t.name === undefined) continue;
			if (!seen.has(t.name)) {
				seen.add(t.name);
				params.push({
					name: t.name,
					hint: t.hint,
					cases: t.cases?.map((c) => c.key),
					plural: t.plural === true ? true : undefined,
				});
			}
			if (t.cases === undefined) continue;
			if (depth + 1 > MAX_NESTING_DEPTH) {
				return `nesting deeper than ${MAX_NESTING_DEPTH} levels`;
			}
			for (const c of t.cases) {
				const inner = tokenize(c.body);
				if (!Array.isArray(inner)) return inner.error;
				const err = visit(inner, depth + 1);
				if (err !== null) return err;
			}
		}
		return null;
	};
	const error = visit(tokens, 0);
	return error === null ? params : { error };
};

/** Parse a stored template + declared kind into a validated shape. */
export const parseMessage = (kind: MessageKind, template: string): ParseResult => {
	if (kind === "text" && MARKUP_RE.test(template)) {
		return { ok: false, error: "markup is not allowed in text messages" };
	}
	if (kind === "rich" && RICH_FORBIDDEN_RE.test(template)) {
		return { ok: false, error: "forbidden markup in rich message" };
	}
	const tokens = tokenize(template);
	if (!Array.isArray(tokens)) return { ok: false, error: tokens.error };
	const sig = collectSignature(tokens);
	if (!Array.isArray(sig)) return { ok: false, error: sig.error };
	return { ok: true, message: { kind, template, params: sig } };
};

/** Extract the declared param signature from a raw template (no kind check). */
export const paramSignature = (template: string): MessageParam[] | { error: string } => {
	const tokens = tokenize(template);
	if (!Array.isArray(tokens)) return { error: tokens.error };
	return collectSignature(tokens);
};

/** String() itself can throw (hostile toString/Symbol.toPrimitive) —
 * last-resort coercion that can never throw. */
const safeString = (value: unknown): string => {
	try {
		return String(value);
	} catch {
		return "[unprintable]";
	}
};

/**
 * Format one param value. Never throws: JSON.stringify rejects
 * circular refs and BigInt, Intl.* constructors reject exotic locales
 * and values — a throw here would surface as a defect (HTTP 500) on
 * every render, so failures degrade to a plain string.
 */
const formatParam = (value: unknown, hint: ParamHint | undefined, locale: string): string => {
	if (value === null || value === undefined) return "";
	try {
		switch (hint) {
			case "number":
				return typeof value === "number"
					? new Intl.NumberFormat(locale).format(value)
					: safeString(value);
			case "date":
				return value instanceof Date
					? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value)
					: safeString(value);
			case "datetime":
				return value instanceof Date
					? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
							value,
						)
					: safeString(value);
			case "relative":
				return value instanceof Date
					? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
							Math.round((value.getTime() - Date.now()) / 1000),
							"second",
						)
					: safeString(value);
			case "list":
				return Array.isArray(value)
					? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
							value.map(safeString),
						)
					: safeString(value);
			default: {
				if (typeof value !== "object") return safeString(value);
				// JSON.stringify can also return undefined (toJSON →
				// undefined) despite the string return type.
				const json: unknown = JSON.stringify(value);
				return typeof json === "string" ? json : safeString(value);
			}
		}
	} catch {
		return safeString(value);
	}
};

const renderTokens = (
	tokens: readonly Token[],
	params: Readonly<Record<string, unknown>>,
	locale: string,
	pound?: string,
	depth = 0,
): string => {
	let out = "";
	for (const t of tokens) {
		if (t.kind === "text") {
			// Inside a plural case, `#` renders the plural arg (ICU) —
			// except `#` immediately followed by a digit, which reads as
			// an id reference ("Consultation #42") and stays literal.
			out += pound === undefined ? t.text : t.text!.replace(/#(?!\d)/g, pound);
			continue;
		}
		const value = params[t.name!];
		if (t.cases) {
			// plural: Intl.PluralRules picks the category; select: direct match.
			// Exact "=N" keys take precedence over categories.
			let key: string | undefined;
			if (t.plural && typeof value === "number") {
				try {
					const exact = t.cases.find((c) => c.key === `=${value}`);
					key = exact?.key ?? new Intl.PluralRules(locale).select(value) ?? undefined;
				} catch {
					// Exotic locale — fall back to the select/other path.
					key = undefined;
				}
			} else {
				key = safeString(value ?? "");
			}
			// `other` is the required ICU fallback when no case matches.
			const body =
				t.cases.find((c) => c.key === key)?.body ?? t.cases.find((c) => c.key === "other")?.body;
			if (body !== undefined && depth < MAX_NESTING_DEPTH) {
				const inner = tokenize(body);
				if (Array.isArray(inner)) {
					let innerPound: string | undefined;
					if (t.plural && typeof value === "number") {
						try {
							innerPound = new Intl.NumberFormat(locale).format(value);
						} catch {
							innerPound = undefined;
						}
					}
					out += renderTokens(inner, params, locale, innerPound, depth + 1);
				}
			}
			continue;
		}
		out += formatParam(value, t.hint, locale);
	}
	return out;
};

/** Render a template with params. Missing params render as "". */
export const renderMessage = (
	template: string,
	params: Readonly<Record<string, unknown>>,
	locale: string,
): string => {
	const tokens = tokenize(template);
	if (!Array.isArray(tokens)) return template;
	return renderTokens(tokens, params, locale);
};

/**
 * Positional catalog args → named MF1 params. Declared names map to
 * args by position; missing args stay `undefined` (renderMessage
 * renders them as ""), extra args are ignored.
 */
export const zipArgs = (
	names: readonly string[],
	args: readonly unknown[],
): Record<string, unknown> => {
	const params: Record<string, unknown> = {};
	for (let i = 0; i < names.length; i++) params[names[i]!] = args[i];
	return params;
};

/**
 * A function-valued catalog leaf that renders an MF1 template — the
 * DB-editable form of `(n) => \`${n} items\``. Carries the source
 * template + positional param names as metadata so the manifest
 * generator, baseline importer and sliceMessages can treat it as data;
 * the call signature stays assignable to the catalog's declared
 * `(…) => string` field types.
 */
export interface ParametrizedMessage {
	readonly i18nTemplate: string;
	readonly i18nParams: readonly string[];
	(...args: readonly unknown[]): string;
}

/**
 * Build a ParametrizedMessage: `paramMessage(locale, tpl, ["n"])`
 * returns `(…args) => renderMessage(tpl, {n: args[0], …}, locale)`.
 */
export const paramMessage = (
	locale: string,
	template: string,
	params: readonly string[],
): ParametrizedMessage => {
	const render = (...args: readonly unknown[]): string =>
		renderMessage(template, zipArgs(params, args), locale);
	return Object.assign(render, { i18nTemplate: template, i18nParams: params });
};

/** True for catalog leaves built by paramMessage (metadata on a function). */
export const isParametrizedMessage = (value: unknown): value is ParametrizedMessage =>
	typeof value === "function" && "i18nTemplate" in value;

/**
 * Validate a template against a declared param signature. `expected`
 * params come from the manifest/registry (the contract); `actual` is
 * what the template itself declares.
 */
export const validateAgainstSignature = (
	template: string,
	expected: readonly MessageParam[],
): ValidationIssue[] => {
	const sig = paramSignature(template);
	if (!Array.isArray(sig)) {
		return [{ code: "bad_syntax", detail: sig.error }];
	}
	const issues: ValidationIssue[] = [];
	const expectedNames = new Set(expected.map((p) => p.name));
	const actualNames = new Set(sig.map((p) => p.name));
	for (const name of actualNames) {
		if (!expectedNames.has(name)) {
			issues.push({ code: "param_mismatch", detail: `undeclared param '{${name}}'` });
		}
	}
	for (const p of expected) {
		if (!actualNames.has(p.name)) {
			issues.push({ code: "param_mismatch", detail: `missing param '{${p.name}}'` });
		}
	}
	// hint parity: same name must carry the same hint on both sides
	for (const a of sig) {
		const e = expected.find((p) => p.name === a.name);
		if (e && e.hint !== a.hint) {
			issues.push({
				code: "param_mismatch",
				detail: `param '{${a.name}}' hint '${a.hint ?? "none"}' != '${e.hint ?? "none"}'`,
			});
		}
	}
	return issues;
};

/** Pseudo-locale for QA (PL-008 Phase 6): `qps` resolves the default
 * locale's templates, then accents vowels, wraps in brackets and pads
 * ~30% so layout overflows surface in testing. Param tokens `{…}` are
 * left intact so signatures still validate. */
export const PSEUDO_LOCALE = "qps";

const PSEUDO_ACCENTS: Readonly<Record<string, string>> = {
	a: "á",
	e: "é",
	i: "í",
	o: "ó",
	u: "ú",
	A: "Á",
	E: "É",
	I: "Í",
	O: "Ó",
	U: "Ú",
};

const accentVowels = (text: string): string =>
	text.replace(/[aeiouAEIOU]/g, (c) => PSEUDO_ACCENTS[c] ?? c);

/**
 * Re-emit tokens with copy accented but syntax verbatim: param names,
 * formatter hints, plural/select keywords and case keys must survive
 * untouched or the template stops parsing. Case BODIES are copy and
 * recurse through the same transform (nested params included).
 */
const pseudoTokens = (tokens: readonly Token[], depth = 0): string =>
	tokens
		.map((t) => {
			if (t.kind === "text") return accentVowels(t.text!);
			let inner = t.name!;
			if (t.hint !== undefined) inner += `, ${t.hint}`;
			if (t.cases !== undefined) {
				inner += `, ${t.plural === true ? "plural" : "select"}, `;
				inner += t.cases
					.map((c) => {
						const bodyTokens = tokenize(c.body);
						// Past the depth cap emit the body verbatim —
						// accenting raw text would corrupt nested `{param}`
						// names and break the template.
						const body = !Array.isArray(bodyTokens)
							? accentVowels(c.body)
							: depth < MAX_NESTING_DEPTH
								? pseudoTokens(bodyTokens, depth + 1)
								: c.body;
						return `${c.key}{${body}}`;
					})
					.join(" ");
			}
			return `{${inner}}`;
		})
		.join("");

export const pseudoLocalize = (template: string): string => {
	const tokens = tokenize(template);
	// Unparseable template: accent the raw text and leave every brace
	// span verbatim — better an unpretty pseudo string than a broken one.
	const accented = Array.isArray(tokens)
		? pseudoTokens(tokens)
		: template
				.split(/(\{[^}]*\})/g)
				.map((part, i) => (i % 2 === 1 ? part : accentVowels(part)))
				.join("");
	const pad = "·".repeat(Math.ceil(accented.length * 0.3));
	return `⟦${accented}${pad}⟧`;
};
