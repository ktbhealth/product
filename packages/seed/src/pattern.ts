/**
 * Minimal regex→string generator for `@ktb/seed`.
 *
 * The `@ktb/json-schema` subset accepts any JS-regex `pattern`, but only
 * a safe, common subset is generatable: literals, `.`, escapes
 * (`\d \w \s` and friends), character classes (incl. ranges and
 * negation), groups `(...)` / `(?:...)`, alternation `|`, anchors
 * `^`/`$` (ignored — they are zero-width) and quantifiers
 * `* + ? {n} {n,} {n,m}` (lazy `?` suffix accepted and ignored).
 *
 * Anything else — lookarounds, backreferences, named groups, inline
 * flags, `\x`-less exotic escapes we don't model — throws
 * {@link SeedError} so callers fail loudly instead of emitting
 * non-conforming data. Generated candidates are still verified against
 * the real `RegExp` by the caller before being returned.
 */

import { SeedError } from "./errors.ts";

/** Hard cap on generated pattern output — guards `(a+)+`-style
 * blowups the subset checker already rejects, plus `{10000}` quantifiers. */
const MAX_PATTERN_OUTPUT = 1024;
/** Per-quantifier expansion cap. */
const MAX_REPEAT = 64;
/** Default upper bound for unbounded quantifiers. */
const UNBOUNDED_MAX = 8;
/** Code-point window used to expand negated classes: printable ASCII. */
const PRINTABLE_LO = 0x20;
const PRINTABLE_HI = 0x7e;

type Range = readonly [number, number];

type Atom =
	| { readonly t: "lit"; readonly ch: string }
	| { readonly t: "any" }
	| { readonly t: "cls"; readonly ranges: readonly Range[]; readonly negate: boolean }
	| { readonly t: "group"; readonly node: Node }
	| { readonly t: "empty" };

interface Part {
	readonly atom: Atom;
	readonly min: number;
	readonly max: number;
}

type Node =
	| { readonly t: "seq"; readonly parts: readonly Part[] }
	| { readonly t: "alt"; readonly options: readonly Node[] };

/** `\d`/`\w`/`\s` → code-point ranges (lowercase keys). */
const CLASS_ESCAPE_RANGES: Readonly<Partial<Record<"d" | "w" | "s", readonly Range[]>>> = {
	d: [[0x30, 0x39]],
	w: [
		[0x30, 0x39],
		[0x41, 0x5a],
		[0x5f, 0x5f],
		[0x61, 0x7a],
	],
	s: [
		[0x09, 0x0d],
		[0x20, 0x20],
	],
};

class Parser {
	pos = 0;
	constructor(private readonly src: string) {}

	private peek(): string {
		return this.src[this.pos] ?? "";
	}

	private next(): string {
		return this.src[this.pos++] ?? "";
	}

	parse(): Node {
		const node = this.parseAlt();
		if (this.pos !== this.src.length) {
			throw new SeedError(
				`unsupported pattern syntax at offset ${this.pos}: ${this.src.slice(this.pos)}`,
			);
		}
		return node;
	}

	private parseAlt(): Node {
		const options = [this.parseSeq()];
		while (this.peek() === "|") {
			this.next();
			options.push(this.parseSeq());
		}
		return options.length === 1 ? (options[0] as Node) : { t: "alt", options };
	}

	private parseSeq(): Node {
		const parts: Part[] = [];
		while (this.pos < this.src.length && this.peek() !== ")" && this.peek() !== "|") {
			parts.push(this.parseRepeat());
		}
		return { t: "seq", parts };
	}

	private parseRepeat(): Part {
		const atom = this.parseAtom();
		const c = this.peek();
		let min = 1;
		let max = 1;
		if (c === "*") {
			this.next();
			min = 0;
			max = UNBOUNDED_MAX;
		} else if (c === "+") {
			this.next();
			min = 1;
			max = UNBOUNDED_MAX;
		} else if (c === "?") {
			this.next();
			min = 0;
			max = 1;
		} else if (c === "{") {
			const m = /^\{(\d+)(?:,(\d*))?\}/.exec(this.src.slice(this.pos));
			if (!m) throw new SeedError(`unsupported quantifier at offset ${this.pos}`);
			this.pos += m[0].length;
			min = Number(m[1]);
			max = m[2] === undefined ? min : m[2] === "" ? MAX_REPEAT : Number(m[2]);
			if (max > MAX_REPEAT) max = MAX_REPEAT;
		} else {
			return { atom, min: 1, max: 1 };
		}
		if (min > MAX_REPEAT) min = MAX_REPEAT;
		if (this.peek() === "?") this.next(); // lazy suffix — same language
		return { atom, min, max };
	}

	private parseAtom(): Atom {
		const c = this.next();
		switch (c) {
			// parseSeq only calls parseAtom while pos < length, so c is
			// never "" here — an empty lit would emit nothing anyway.
			case "(": {
				if (this.peek() === "?") {
					this.next(); // '?'
					const marker = this.next();
					if (marker !== ":") {
						throw new SeedError(`unsupported group syntax "(?${marker}"`);
					}
				}
				const node = this.parseAlt();
				if (this.next() !== ")") throw new SeedError("unterminated group");
				return { t: "group", node };
			}
			case "[":
				return this.parseClass();
			case ".":
				return { t: "any" };
			case "^":
			case "$":
				return { t: "empty" };
			case "\\":
				return this.parseEscape();
			default:
				return { t: "lit", ch: c };
		}
	}

	private parseClass(): Atom {
		let negate = false;
		if (this.peek() === "^") {
			this.next();
			negate = true;
		}
		const ranges: Range[] = [];
		// JS semantics: "]" ALWAYS closes the class — "[]" is an empty
		// (unsatisfiable) class and "[^]" matches any char. No POSIX
		// literal-]-first rule.
		while (this.pos < this.src.length) {
			if (this.peek() === "]") {
				this.next();
				return { t: "cls", ranges, negate };
			}
			// Class escapes inside [] contribute a whole set — they can't
			// be range endpoints, so handle them before range parsing.
			// NOTE: src[pos+1] may be undefined at end-of-input — guard
			// explicitly (RegExp.test would coerce it to "undefined").
			const nextCh = this.src[this.pos + 1];
			if (this.peek() === "\\" && nextCh !== undefined && /[dDwWsS]/.test(nextCh)) {
				this.next();
				const e = this.next();
				const inner = CLASS_ESCAPE_RANGES[e.toLowerCase() as "d" | "w" | "s"] as Range[];
				// Negated inner escape ([\D] ≈ non-digits): approximate with
				// the printable complement — the caller's RegExp verify
				// step catches any mismatch.
				if (e === "D" || e === "W" || e === "S") {
					for (const r of complement(inner)) ranges.push(r);
				} else {
					ranges.push(...inner);
				}
				continue;
			}
			const lo = this.parseClassChar();
			if (this.peek() === "-" && this.src[this.pos + 1] !== "]") {
				this.next();
				const hi = this.parseClassChar();
				if (hi < lo) throw new SeedError("reversed character range");
				ranges.push([lo, hi]);
			} else {
				ranges.push([lo, lo]);
			}
		}
		throw new SeedError("unterminated character class");
	}

	/** One class item → code point (class escapes are handled by the
	 * caller before this runs). */
	private parseClassChar(): number {
		const c = this.next();
		if (c === "\\") {
			const e = this.next();
			return this.escapeChar(e);
		}
		return c.codePointAt(0) as number;
	}

	/** Parse a `\x` escape outside a class → Atom. */
	private parseEscape(): Atom {
		const e = this.next();
		if (e === "") throw new SeedError("trailing backslash");
		if (/^[1-9]$/.test(e)) throw new SeedError(`backreference \\${e} unsupported`);
		// Negated class escapes are classes with negate flipped.
		if (e === "D" || e === "W" || e === "S") {
			return {
				t: "cls",
				ranges: CLASS_ESCAPE_RANGES[e.toLowerCase() as "d" | "w" | "s"] as Range[],
				negate: true,
			};
		}
		const ranges = this.escapeRanges(e);
		if (ranges) return { t: "cls", ranges, negate: false };
		if (e === "b" || e === "B") return { t: "empty" }; // word boundary — zero-width
		return { t: "lit", ch: String.fromCodePoint(this.escapeChar(e)) };
	}

	/** Class escapes → code-point ranges via the shared table (only
	 * positive `d`/`w`/`s` reach here — negated forms are intercepted
	 * in {@link parseEscape} first). */
	private escapeRanges(e: string): readonly Range[] | undefined {
		return CLASS_ESCAPE_RANGES[e as "d" | "w" | "s"];
	}

	/** Non-class escape → code point. */
	private escapeChar(e: string): number {
		if (e === "") throw new SeedError("trailing backslash");
		switch (e) {
			case "n":
				return 0x0a;
			case "t":
				return 0x09;
			case "r":
				return 0x0d;
			case "f":
				return 0x0c;
			case "v":
				return 0x0b;
			case "0":
				return 0x00;
			case "b":
				// Inside a class \b is backspace (outside it parseEscape
				// intercepts it as a zero-width boundary first).
				return 0x08;
			case "x": {
				const h = this.src.slice(this.pos, this.pos + 2);
				if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new SeedError("bad \\x escape");
				this.pos += 2;
				return parseInt(h, 16);
			}
			case "u": {
				const h = this.src.slice(this.pos, this.pos + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new SeedError("bad \\u escape");
				this.pos += 4;
				return parseInt(h, 16);
			}
			default:
				// Escaped punctuation/literal (\., \\, \/, \-, …) — the
				// backslash quotes the char.
				return e.codePointAt(0) as number;
		}
	}
}

interface GenState {
	out: string;
	readonly limit: number;
}

const emit = (st: GenState, s: string): void => {
	st.out += s;
	if (st.out.length > st.limit) {
		throw new SeedError(`pattern generates more than ${st.limit} chars`);
	}
};

const randomInRanges = (rng: () => number, ranges: readonly Range[], negate: boolean): string => {
	let pool: Range[];
	if (negate) {
		// Complement within printable ASCII — keeps output sane and
		// still satisfies `[^…]` for typical patterns.
		pool = complement(ranges);
	} else {
		pool = [...ranges];
	}
	const total = pool.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0);
	if (total <= 0) throw new SeedError("character class matches nothing generatable");
	let roll = Math.floor(rng() * total);
	for (const [lo, hi] of pool) {
		const size = hi - lo + 1;
		if (roll < size) return String.fromCodePoint(lo + roll);
		roll -= size;
	}
	/* v8 ignore next -- unreachable: roll < total by construction */
	throw new SeedError("character class roll overflow");
};

/** Complement of `ranges` within [PRINTABLE_LO, PRINTABLE_HI]. */
const complement = (ranges: readonly Range[]): Range[] => {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: Range[] = [];
	let cur = PRINTABLE_LO;
	for (const [lo, hi] of sorted) {
		const l = Math.max(lo, PRINTABLE_LO);
		const h = Math.min(hi, PRINTABLE_HI);
		if (h < cur) continue;
		if (l > cur) out.push([cur, l - 1]);
		cur = Math.max(cur, h + 1);
		if (cur > PRINTABLE_HI) break;
	}
	if (cur <= PRINTABLE_HI) out.push([cur, PRINTABLE_HI]);
	return out;
};

const genAtom = (rng: () => number, st: GenState, atom: Atom): void => {
	switch (atom.t) {
		case "lit":
			emit(st, atom.ch);
			return;
		case "empty":
			return;
		case "any":
			// `.` doesn't match \n by default — emit a printable non-newline.
			emit(st, randomInRanges(rng, [[0x20, 0x7e]], false));
			return;
		case "cls":
			emit(st, randomInRanges(rng, atom.ranges, atom.negate));
			return;
		case "group":
			genNode(rng, st, atom.node);
			return;
	}
};

const genNode = (rng: () => number, st: GenState, node: Node): void => {
	if (node.t === "alt") {
		const opt = node.options[Math.floor(rng() * node.options.length)] as Node;
		genNode(rng, st, opt);
		return;
	}
	for (const part of node.parts) {
		const count = part.min + Math.floor(rng() * (part.max - part.min + 1));
		for (let i = 0; i < count; i++) genAtom(rng, st, part.atom);
	}
};

/**
 * Generate a string matching `pattern` (a JS regex source). `limit`
 * caps output length (typically the schema's `maxLength`, else
 * {@link MAX_PATTERN_OUTPUT}). Throws {@link SeedError} on unsupported
 * syntax or when the pattern can't be satisfied within the limit.
 */
export const generateFromPattern = (
	pattern: string,
	rng: () => number,
	limit = MAX_PATTERN_OUTPUT,
): string => {
	if (pattern.length > 200) {
		// Same bound the subset checker enforces — unreachable for valid
		// schemas, kept as defense in depth.
		throw new SeedError("pattern exceeds MAX_PATTERN_LENGTH");
	}
	const ast = new Parser(pattern).parse();
	const st: GenState = { out: "", limit: Math.min(limit, MAX_PATTERN_OUTPUT * 4) };
	genNode(rng, st, ast);
	return st.out;
};
