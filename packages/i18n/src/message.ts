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

/** Parse a stored template + declared kind into a validated shape. */
export const parseMessage = (kind: MessageKind, template: string): ParseResult => {
	if (kind === "text" && MARKUP_RE.test(template)) {
		return { ok: false, error: "markup is not allowed in text messages" };
	}
	const tokens = tokenize(template);
	if (!Array.isArray(tokens)) return { ok: false, error: tokens.error };
	const params: MessageParam[] = [];
	const seen = new Set<string>();
	for (const t of tokens) {
		if (t.kind !== "param" || t.name === undefined || seen.has(t.name)) continue;
		seen.add(t.name);
		params.push({
			name: t.name,
			hint: t.hint,
			cases: t.cases?.map((c) => c.key),
			plural: t.plural === true ? true : undefined,
		});
	}
	return { ok: true, message: { kind, template, params } };
};

/** Extract the declared param signature from a raw template (no kind check). */
export const paramSignature = (template: string): MessageParam[] | { error: string } => {
	const tokens = tokenize(template);
	if (!Array.isArray(tokens)) return { error: tokens.error };
	const params: MessageParam[] = [];
	const seen = new Set<string>();
	for (const t of tokens) {
		if (t.kind !== "param" || t.name === undefined || seen.has(t.name)) continue;
		seen.add(t.name);
		params.push({
			name: t.name,
			hint: t.hint,
			cases: t.cases?.map((c) => c.key),
			plural: t.plural === true ? true : undefined,
		});
	}
	return params;
};

const formatParam = (value: unknown, hint: ParamHint | undefined, locale: string): string => {
	if (value === null || value === undefined) return "";
	switch (hint) {
		case "number":
			return typeof value === "number"
				? new Intl.NumberFormat(locale).format(value)
				: String(value);
		case "date":
			return value instanceof Date
				? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value)
				: String(value);
		case "datetime":
			return value instanceof Date
				? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value)
				: String(value);
		case "relative":
			return value instanceof Date
				? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
						Math.round((value.getTime() - Date.now()) / 1000),
						"second",
					)
				: String(value);
		case "list":
			return Array.isArray(value)
				? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
						value.map(String),
					)
				: String(value);
		default:
			return typeof value === "object" ? JSON.stringify(value) : String(value);
	}
};

const renderTokens = (
	tokens: readonly Token[],
	params: Readonly<Record<string, unknown>>,
	locale: string,
	pound?: string,
): string => {
	let out = "";
	for (const t of tokens) {
		if (t.kind === "text") {
			// Inside a plural case, `#` renders the plural arg (ICU) —
			// except `#` immediately followed by a digit, which reads as
			// an id reference ("Consultation #42") and stays literal.
			out +=
				pound === undefined ? t.text : t.text!.replace(/#(?!\d)/g, pound);
			continue;
		}
		const value = params[t.name!];
		if (t.cases) {
			// plural: Intl.PluralRules picks the category; select: direct match.
			// Exact "=N" keys take precedence over categories.
			let key: string | undefined;
			if (t.plural && typeof value === "number") {
				const exact = t.cases.find((c) => c.key === `=${value}`);
				key = exact?.key ?? new Intl.PluralRules(locale).select(value) ?? undefined;
			} else {
				key = String(value ?? "");
			}
			// `other` is the required ICU fallback when no case matches.
			const body =
				t.cases.find((c) => c.key === key)?.body ?? t.cases.find((c) => c.key === "other")?.body;
			if (body !== undefined) {
				const inner = tokenize(body);
				if (Array.isArray(inner)) {
					const innerPound =
						t.plural && typeof value === "number"
							? new Intl.NumberFormat(locale).format(value)
							: undefined;
					out += renderTokens(inner, params, locale, innerPound);
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
const pseudoTokens = (tokens: readonly Token[]): string =>
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
						const body = Array.isArray(bodyTokens)
							? pseudoTokens(bodyTokens)
							: accentVowels(c.body);
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
