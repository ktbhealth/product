/**
 * Font variation + coverage probing (catalog font upload pipeline).
 *
 * `parseFontVariations` reads two sfnt tables out of the same
 * containers `parseFontMetrics` accepts (bare TTF/OTF, WOFF, WOFF2):
 *
 * - `fvar` — the variation axes. Only the `wght` (weight) axis is
 *   consumed: its min/default/max become a CSS `font-weight` range
 *   (`font-weight: 100 900`) on the emitted `@font-face` instead of
 *   discrete weights. Presence of `fvar` marks the font `variable`.
 * - `cmap` — character coverage, collapsed into `unicode-range`
 *   descriptor text so browsers skip downloading the face for text it
 *   cannot render (the practical, dependency-free stand-in for real
 *   font subsetting — glyph subsetting needs harfbuzz/fonttools-class
 *   tooling that cannot run in workerd).
 *
 * Everything is plain TS over Uint8Array — no node:* APIs, no new
 * deps. Returns null for unrecognized containers; recognized fonts
 * yield `{ variable, weightAxis?, unicodeRange? }` with absent fields
 * simply omitted.
 */

import { findTable, woffTable, woff2Tables } from "./font-metrics.ts";

const u16 = (v: DataView, o: number) => v.getUint16(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);
const i32 = (v: DataView, o: number) => v.getInt32(o);

const WOFF2_TAG = "wOF2";
const WOFF_TAG = "wOFF";
const SFNT_SIGNATURES = new Set(["true", "typ1", "OTTO"]);

/** `wght` axis bounds in CSS font-weight units (fvar Fixed 16.16). */
export interface FontWeightAxis {
	readonly min: number;
	readonly default: number;
	readonly max: number;
}

export interface FontVariationInfo {
	/** True when the font carries an `fvar` table (any axes). */
	readonly variable: boolean;
	/** `wght` axis range when present and sane; absent otherwise. */
	readonly weightAxis?: FontWeightAxis;
	/** Ready-to-emit `unicode-range` descriptor value ("U+0020-007E,
	 * U+00C0-00FF"), or absent when coverage is unknown/unwieldy. */
	readonly unicodeRange?: string;
}

const viewOf = (bytes: Uint8Array): DataView =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Fetch one sfnt table's raw bytes for any supported container.
 * WOFF2 never reaches here — its single Brotli stream is decoded
 * once by the caller ({@link parseFontVariations}). */
const tableBytes = async (
	bytes: Uint8Array,
	tag: string,
	format?: string,
): Promise<Uint8Array | null> => {
	/* v8 ignore next -- callers only reach here with >= 12-byte inputs */
	if (bytes.byteLength < 12) return null;
	const head4 = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => bytes[i]!));
	try {
		if (head4 === WOFF_TAG) return await woffTable(bytes, tag);
		if (SFNT_SIGNATURES.has(head4) || format === "ttf" || format === "otf") {
			const rec = findTable(bytes, tag);
			if (rec === null) return null;
			if (rec.offset + rec.length > bytes.byteLength) return null;
			return bytes.subarray(rec.offset, rec.offset + rec.length);
		}
		return null;
	} catch {
		return null;
	}
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Parse the `fvar` table: header counts + axis records. Only the
 * `wght` axis is kept — its Fixed values convert to CSS font-weight
 * numbers. Returns null when the table is absent/truncated/malformed
 * or carries no usable wght axis.
 */
const parseFvar = (
	bytes: Uint8Array | null,
): { variable: boolean; weightAxis?: FontWeightAxis } => {
	if (bytes === null) return { variable: false };
	// An fvar table too short for its header is still an fvar table —
	// the font IS variable, we just can't read the axes.
	if (bytes.byteLength < 16) return { variable: true };
	const v = viewOf(bytes);
	const axisCount = u16(v, 8);
	const axisSize = u16(v, 10);
	const axesOffset = u16(v, 4);
	if (axisSize < 20 || axesOffset + axisCount * axisSize > bytes.byteLength) {
		return { variable: true };
	}
	let weightAxis: FontWeightAxis | undefined;
	for (let i = 0; i < axisCount; i++) {
		const o = axesOffset + i * axisSize;
		const tag = String.fromCharCode(
			v.getUint8(o),
			v.getUint8(o + 1),
			v.getUint8(o + 2),
			v.getUint8(o + 3),
		);
		if (tag !== "wght") continue;
		// Fixed 16.16 signed values at +4/+8/+12.
		const min = round4(i32(v, o + 4) / 65536);
		const def = round4(i32(v, o + 8) / 65536);
		const max = round4(i32(v, o + 12) / 65536);
		if (
			Number.isFinite(min) &&
			Number.isFinite(def) &&
			Number.isFinite(max) &&
			min <= def &&
			def <= max
		) {
			// CSS font-weight accepts 1–1000 — clamp rather than trust
			// the fvar bytes blindly (the monotonic clamp preserves
			// min <= default <= max). insertCatalogFontAsset applies
			// the same rule to its own input.
			const clamp = (n: number): number => Math.min(1000, Math.max(1, n));
			weightAxis = { min: clamp(min), default: clamp(def), max: clamp(max) };
		}
	}
	return { variable: true, ...(weightAxis === undefined ? {} : { weightAxis }) };
};

interface CmapSubtable {
	readonly format: number;
	readonly offset: number;
}

/** Pick the best cmap subtable: format 12 (full UCS-4) preferred,
 * format 4 (BMP) as fallback. */
const pickCmapSubtable = (v: DataView, bytes: Uint8Array): CmapSubtable | null => {
	if (bytes.byteLength < 4) return null;
	const numTables = u16(v, 2);
	if (4 + numTables * 8 > bytes.byteLength) return null;
	let best4: CmapSubtable | null = null;
	for (let i = 0; i < numTables; i++) {
		const o = 4 + i * 8;
		const offset = u32(v, o + 4);
		if (offset + 2 > bytes.byteLength) continue;
		const format = u16(v, offset);
		if (format === 12) return { format, offset };
		if (format === 4 && best4 === null) best4 = { format, offset };
	}
	return best4;
};

/** Format-12 groups → covered codepoint ranges (groups are already
 * sorted and non-overlapping per spec; merged defensively anyway). */
const cmap12Ranges = (v: DataView, t: CmapSubtable, end: number): [number, number][] | null => {
	if (t.offset + 16 > end) return null;
	const numGroups = u32(v, t.offset + 12);
	if (t.offset + 16 + numGroups * 12 > end) return null;
	const ranges: [number, number][] = [];
	for (let i = 0; i < numGroups; i++) {
		const o = t.offset + 16 + i * 12;
		const start = u32(v, o);
		const stop = Math.min(u32(v, o + 4), 0x10ffff);
		if (start <= stop) ranges.push([start, stop]);
	}
	return ranges;
};

/**
 * Format-4 segments → covered codepoint ranges. This is a coverage
 * approximation: a segment counts as covered even when its glyphId
 * resolves to 0 (missing glyph) — over-inclusion only makes the
 * browser download the face slightly more often, never misrenders.
 */
const cmap4Ranges = (v: DataView, t: CmapSubtable, end: number): [number, number][] | null => {
	if (t.offset + 14 > end) return null;
	const segCount = u16(v, t.offset + 6) / 2;
	if (segCount === 0) return null;
	const endCodes = t.offset + 14;
	const startCodes = endCodes + segCount * 2 + 2; // + reservedPad
	if (startCodes + segCount * 6 > end) return null;
	const ranges: [number, number][] = [];
	for (let i = 0; i < segCount; i++) {
		const stop = u16(v, endCodes + i * 2);
		const start = u16(v, startCodes + i * 2);
		if (start === 0xffff && stop === 0xffff) continue; // required sentinel
		if (start <= stop) ranges.push([start, stop]);
	}
	return ranges;
};

/** Sort + merge overlapping/adjacent ranges; null when the result is
 * too fragmented to be a useful unicode-range hint (>128 entries —
 * typical of huge CJK fonts where the descriptor would dwarf the
 * savings). */
const mergeRanges = (ranges: [number, number][]): [number, number][] | null => {
	if (ranges.length === 0) return null;
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [[sorted[0]![0], sorted[0]![1]]];
	for (const [start, stop] of sorted.slice(1)) {
		const last = merged[merged.length - 1]!;
		if (start <= last[1] + 1) {
			last[1] = Math.max(last[1], stop);
		} else {
			merged.push([start, stop]);
		}
	}
	return merged.length > 128 ? null : merged;
};

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");

/** Serialize merged ranges as a `unicode-range` descriptor value. */
const rangesToUnicodeRange = (ranges: readonly [number, number][]): string =>
	ranges
		.map(([start, stop]) => (start === stop ? `U+${hex(start)}` : `U+${hex(start)}-${hex(stop)}`))
		.join(", ");

const MAX_UNICODE_RANGE_BYTES = 2048;

/**
 * Parse the `cmap` table into a `unicode-range` descriptor string.
 * Format 12 preferred (full UCS-4 coverage), format 4 fallback (BMP
 * only — supplementary-plane glyphs simply stay uncovered, matching
 * what a BMP-only descriptor could ever express).
 */
const parseCmap = (cmap: Uint8Array | null): string | undefined => {
	if (cmap === null) return undefined;
	const v = viewOf(cmap);
	const sub = pickCmapSubtable(v, cmap);
	if (sub === null) return undefined;
	const ranges =
		sub.format === 12
			? cmap12Ranges(v, sub, cmap.byteLength)
			: cmap4Ranges(v, sub, cmap.byteLength);
	if (ranges === null) return undefined;
	const merged = mergeRanges(ranges);
	if (merged === null) return undefined;
	const css = rangesToUnicodeRange(merged);
	// Pathological fonts can still produce a huge descriptor — beyond
	// this cap the hint costs more than it saves, so emit nothing.
	return css.length <= MAX_UNICODE_RANGE_BYTES ? css : undefined;
};

/**
 * Probe a font file for variation axes and character coverage.
 * Accepts the same containers as {@link parseFontMetrics} (TTF/OTF,
 * WOFF, WOFF2); `format` is the upload extension hint for containers
 * whose sfnt signature is nonstandard. Never throws — corrupt input
 * degrades to null/absent fields.
 */
export const parseFontVariations = async (
	bytes: Uint8Array,
	format?: string,
): Promise<FontVariationInfo | null> => {
	try {
		if (bytes.byteLength < 12) return null;
		const head4 = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => bytes[i]!));
		const recognized =
			SFNT_SIGNATURES.has(head4) ||
			head4 === WOFF_TAG ||
			head4 === WOFF2_TAG ||
			format === "ttf" ||
			format === "otf" ||
			format === "woff" ||
			format === "woff2";
		if (!recognized) return null;
		let fvar: Uint8Array | null;
		let cmap: Uint8Array | null;
		if (head4 === WOFF2_TAG) {
			// WOFF2 stores every table in one Brotli stream — decode
			// once and slice both probes out of the shared payload.
			const decoded = await woff2Tables(bytes);
			const slice = (tag: string): Uint8Array | null => {
				if (decoded === null) return null;
				const t = decoded.tables.get(tag);
				return t === undefined ? null : decoded.data.subarray(t.offset, t.offset + t.length);
			};
			fvar = slice("fvar");
			cmap = slice("cmap");
		} else {
			[fvar, cmap] = await Promise.all([
				tableBytes(bytes, "fvar", format),
				tableBytes(bytes, "cmap", format),
			]);
		}
		// unicode-range applies to static fonts too — return whatever
		// the cmap probe found even without an fvar table.
		const variation = parseFvar(fvar);
		const unicodeRange = parseCmap(cmap);
		return {
			variable: variation.variable,
			...(variation.weightAxis === undefined ? {} : { weightAxis: variation.weightAxis }),
			...(unicodeRange === undefined ? {} : { unicodeRange }),
		};
	} catch {
		// v8 ignore next -- defensive: every inner parser already
		// null-guards; this only catches exotic view/buffer edge cases.
		/* v8 ignore next */
		return null;
	}
};
