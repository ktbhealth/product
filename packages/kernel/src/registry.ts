/**
 * registry.ts — the shared id-keyed registry shape.
 *
 * Several packages hand-roll the same in-memory registry: a `Map`
 * behind `register`/`get`/`has`/`list`, where `register` throws on a
 * duplicate id and `get` throws on an unknown id — a programming error
 * surfaced at composition time, never a silent override. `makeRegistry`
 * owns that shape; per-domain typed errors (Data.TaggedError) stay with
 * the domain via the `duplicate`/`unknown` factories, and domain
 * validation that must run between the duplicate check and the insert
 * (e.g. "every stage id resolves") rides `validate`.
 *
 * Registries with different semantics — last-wins replace, `get`
 * returning `undefined`, Effect-wrapped `register`/`die` — do NOT fit
 * and keep their own maps.
 */

/** Error factories — return the value to `throw` (a TaggedError, a
 * plain Error, anything). Absent factories fall back to plain Errors
 * naming the key. */
export interface RegistryErrors<T> {
	/** Thrown by `register` when the key is already present. Runs
	 * BEFORE `validate`, preserving the duplicate-first ordering the
	 * hand-rolled registries had. */
	readonly duplicate?: (id: string, entry: T) => unknown;
	/** Thrown by `get` when the key is absent. */
	readonly unknown?: (id: string) => unknown;
}

export interface RegistryOptions<T> extends RegistryErrors<T> {
	/** The entry's unique registry key. */
	readonly key: (entry: T) => string;
	/** Extra validation run after the duplicate check and before the
	 * insert — may throw typed errors. */
	readonly validate?: (entry: T) => void;
}

/** The registry surface `makeRegistry` returns. */
export interface Registry<T> {
	/** Insert `entry` under `key(entry)`. Throws the `duplicate` error
	 * when the key is taken, then runs `validate`, then inserts —
	 * registration order is preserved by `list`. */
	readonly register: (entry: T) => void;
	/** The entry for `id`. Throws the `unknown` error (or a plain
	 * Error) when absent. */
	readonly get: (id: string) => T;
	/** The entry for `id`, or `undefined` — the non-throwing probe for
	 * callers that map absence onto their own error channel. */
	readonly lookup: (id: string) => T | undefined;
	readonly has: (id: string) => boolean;
	/** All entries in registration order. */
	readonly list: () => readonly T[];
	/** Read-only key → entry view for consumers that need map-shaped
	 * access (e.g. handing the whole table to a runner). Mutating it
	 * bypasses `register`'s duplicate/validate checks — treat as
	 * frozen. */
	readonly map: ReadonlyMap<string, T>;
}

const defaultDuplicate = (id: string): Error => new Error(`duplicate registry entry "${id}"`);

const defaultUnknown = (id: string): Error => new Error(`unknown registry entry "${id}"`);

/** Build an id-keyed registry. Synchronous API — callers compose it
 * inside their own services; thrown errors are typed per domain via
 * {@link RegistryErrors}. */
export const makeRegistry = <T>(options: RegistryOptions<T>): Registry<T> => {
	const entries = new Map<string, T>();
	const duplicate = options.duplicate ?? ((id: string) => defaultDuplicate(id));
	const unknown = options.unknown ?? ((id: string) => defaultUnknown(id));
	return {
		register(entry) {
			const id = options.key(entry);
			if (entries.has(id)) {
				throw duplicate(id, entry);
			}
			options.validate?.(entry);
			entries.set(id, entry);
		},
		get(id) {
			const entry = entries.get(id);
			if (entry === undefined) {
				throw unknown(id);
			}
			return entry;
		},
		lookup: (id) => entries.get(id),
		has: (id) => entries.has(id),
		list: () => [...entries.values()],
		map: entries,
	};
};
