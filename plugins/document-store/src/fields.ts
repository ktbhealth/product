import type { Json } from "effect/Schema";

/**
 * Field DSL for `defineCollection` (P-089) — plugin-contributed document
 * collections are declared as DATA: a map of field name → descriptor.
 * Descriptors are plain JSON values so a whole collection definition can
 * ride the generic `contributions` channel (`PluginContribution.meta`
 * is `JsonObject`) without any kernel changes.
 *
 * `date` fields store **epoch milliseconds** (a finite number) — chosen
 * over ISO strings because comparisons (`$gt`/`$lt`, sorting) stay
 * numeric and timezone-free; callers format at the edge.
 */

export type FieldKind =
	| "string"
	| "number"
	| "boolean"
	| "date"
	| "enum"
	| "json"
	| "array"
	| "ref";

/** Constraints shared by every field kind. All optional. */
export interface FieldOptions {
	/** Missing values fail validation (after `default` is applied). */
	readonly required?: boolean;
	/** Value substituted when the key is absent on write. JSON-only. */
	readonly default?: Json;
	/** Enforce uniqueness within the record's scope bucket (see
	 * service.ts — personal rows: per owner; tenant rows: per tenant). */
	readonly unique?: boolean;
}

export interface StringFieldOptions extends FieldOptions {
	readonly minLength?: number;
	readonly maxLength?: number;
	/** JS regex source — tested against the whole string. */
	readonly pattern?: string;
}

export interface NumberFieldOptions extends FieldOptions {
	readonly min?: number;
	readonly max?: number;
}

/** Array bounds reuse the length-like options: `minLength`/`maxLength`
 * cap the item count (strings cap character count instead). */
export interface ArrayFieldOptions extends FieldOptions {
	readonly minLength?: number;
	readonly maxLength?: number;
}

/** `ref` target: the referenced collection name plus the delete policy
 * applied when a referenced record is deleted. `restrict` (default)
 * fails the delete while in-scope references exist; `cascade` deletes
 * the referencing records; `nullify` rewrites the field to `null`.
 * Policies are best-effort and scope-bound — see service.ts. */
export interface RefTarget {
	readonly collection: string;
	readonly onDelete?: "restrict" | "cascade" | "nullify";
}

export interface RefFieldOptions extends FieldOptions {}

/**
 * One field descriptor — a discriminated record keyed by `kind`.
 * `kind`-specific members are optional on the base type; the builders
 * below produce the narrowed shapes `InferField` switches on.
 */
export interface FieldDescriptor {
	readonly kind: FieldKind;
	readonly required?: boolean;
	readonly default?: Json;
	readonly unique?: boolean;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly min?: number;
	readonly max?: number;
	readonly values?: readonly string[];
	readonly of?: FieldDescriptor;
	readonly collection?: string;
	readonly onDelete?: "restrict" | "cascade" | "nullify";
}

/** Field map accepted by `defineCollection`. */
export type Fields = Record<string, FieldDescriptor>;

interface EnumField<V extends readonly string[]> {
	readonly kind: "enum";
	readonly values: V;
	readonly required?: boolean;
	readonly default?: Json;
	readonly unique?: boolean;
}

interface ArrayField<O extends FieldDescriptor> {
	readonly kind: "array";
	readonly of: O;
	readonly required?: boolean;
	readonly default?: Json;
	readonly unique?: boolean;
	readonly minLength?: number;
	readonly maxLength?: number;
}

interface ScalarField<
	K extends "string" | "number" | "boolean" | "date" | "json" | "ref",
> extends FieldDescriptor {
	readonly kind: K;
}

/** Typed field builders — `f.string({ required: true })`, etc. The
 * returned literals keep `kind`/`values`/`of` precise so `InferFields`
 * can map them back to TypeScript types. Every result is assignable to
 * `FieldDescriptor` (the runtime/JSON view of the same data). */
export const f = {
	// `const` type params keep option literals (`required: true`,
	// `default: "x"`) precise so InferInsert/InferRecord can tell
	// required keys apart from optional ones.
	string: <const O extends StringFieldOptions = {}>(opts?: O): ScalarField<"string"> & O =>
		({ kind: "string", ...opts }) as ScalarField<"string"> & O,
	number: <const O extends NumberFieldOptions = {}>(opts?: O): ScalarField<"number"> & O =>
		({ kind: "number", ...opts }) as ScalarField<"number"> & O,
	boolean: <const O extends FieldOptions = {}>(opts?: O): ScalarField<"boolean"> & O =>
		({ kind: "boolean", ...opts }) as ScalarField<"boolean"> & O,
	/** Epoch milliseconds (finite number). */
	date: <const O extends NumberFieldOptions = {}>(opts?: O): ScalarField<"date"> & O =>
		({ kind: "date", ...opts }) as ScalarField<"date"> & O,
	enum: <const V extends readonly string[], const O extends FieldOptions = {}>(
		values: V,
		opts?: O,
	): EnumField<V> & O => ({ kind: "enum", values, ...opts }) as EnumField<V> & O,
	json: <const O extends FieldOptions = {}>(opts?: O): ScalarField<"json"> & O =>
		({ kind: "json", ...opts }) as ScalarField<"json"> & O,
	array: <O extends FieldDescriptor, const P extends ArrayFieldOptions = {}>(
		of: O,
		opts?: P,
	): ArrayField<O> & P => ({ kind: "array", of, ...opts }) as ArrayField<O> & P,
	ref: <const O extends RefFieldOptions = {}>(
		target: RefTarget,
		opts?: O,
	): ScalarField<"ref"> & O =>
		({
			kind: "ref",
			collection: target.collection,
			onDelete: target.onDelete ?? "restrict",
			...opts,
		}) as ScalarField<"ref"> & O,
};

/** Map one descriptor literal back to its value type. */
export type InferField<D> = D extends { readonly kind: "string" }
	? string
	: D extends { readonly kind: "number" }
		? number
		: D extends { readonly kind: "boolean" }
			? boolean
			: D extends { readonly kind: "date" }
				? number
				: D extends { readonly kind: "enum"; readonly values: infer V }
					? V extends readonly (infer U)[]
						? U
						: never
					: D extends { readonly kind: "json" }
						? unknown
						: D extends { readonly kind: "array"; readonly of: infer O }
							? O extends FieldDescriptor
								? InferField<O>[]
								: never
							: D extends { readonly kind: "ref" }
								? // `null` is legal for refs ("unset" — nullify
									// writes it; the validator accepts it for
									// required and optional fields alike).
									number | null
								: unknown;

/** Insert/write shape: `required: true` keys are mandatory, every other
 * key may be omitted (defaults and optional fields fill in on write). */
export type InferInsert<F extends Fields> = {
	[K in keyof F as F[K] extends { readonly required: true } ? K : never]-?: InferField<F[K]>;
} & {
	[K in keyof F as F[K] extends { readonly required: true } ? never : K]?: InferField<F[K]>;
};

/** Stored/read shape: every declared key is present; non-required keys
 * may hold `undefined` (absent in the stored JSON). */
export type InferRecord<F extends Fields> = {
	[K in keyof F]: F[K] extends { readonly required: true }
		? InferField<F[K]>
		: InferField<F[K]> | undefined;
};

/** Convenience alias used in service signatures. */
export type InferFields<F extends Fields> = InferRecord<F>;
