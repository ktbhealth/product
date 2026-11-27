import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Delete-time referencer hooks: other plugins register a
 * `RichTextDeleteHook` at layer build (via `Effect.serviceOption` —
 * the rich-text plugin never imports them, keeping the dependency
 * direction one-way: consumers depend on rich-text, never the
 * reverse). The registry answers two questions for the admin delete
 * flow:
 *
 * - `usage(docId)` — which plugins reference the document and what the
 *   referents are (drives the confirmation dialog);
 * - `cleanup(docId, actionId)` — run every hook's cleanup with the
 *   action the admin picked; each hook no-ops on action ids it does
 *   not own, so one dialog choice can cascade through several plugins.
 *
 * The DB foreign key on `pages.rich_text_id` stays the
 * backstop: a hook that fails or is absent (plugin disabled) leaves
 * the row protected and the delete fails.
 */

/** One thing referencing the document — serializable so it can cross
 * the server-fn boundary into the dialog. `path` is an optional link
 * target (e.g. the page's public path). */
export interface RichTextReferencerItem {
	readonly id: number;
	readonly title: string;
	readonly path?: string;
}

/** Per-plugin usage group: `id` is the hook id (also the `owner` the
 * plugin's contributed `dialogAction` chrome entries declare). */
export interface RichTextUsageOwner {
	readonly id: string;
	readonly items: readonly RichTextReferencerItem[];
}

/** A plugin's participation in rich-text deletion. `usage` returns the
 * referents for `docId` (empty = not referenced); `cleanup` performs
 * the admin-chosen `actionId` — hooks MUST succeed silently for action
 * ids they do not own. Both run with the hook's own captured deps, so
 * their Effect requirements stay `never`. */
export interface RichTextDeleteHook {
	readonly id: string;
	readonly usage: (docId: number) => Effect.Effect<readonly RichTextReferencerItem[], unknown>;
	readonly cleanup: (docId: number, actionId: string) => Effect.Effect<void, unknown>;
}

/** The registry shape — exported so the element-kind declaration
 * (./kind.ts) can type its services record via `import type`. */
export interface RichTextDeleteHooksShape {
	/** Register a hook; re-registering the same `id` replaces the
	 * previous entry (layer rebuilds stay idempotent). */
	readonly register: (hook: RichTextDeleteHook) => Effect.Effect<void>;
	/** Referencers grouped by hook id — owners with zero items are
	 * omitted. Hook failures propagate (a hidden referencer is
	 * worse than a failed dialog). */
	readonly usage: (docId: number) => Effect.Effect<readonly RichTextUsageOwner[], unknown>;
	/** Run every registered hook's `cleanup` for `actionId`,
	 * sequentially; the first failure aborts so the caller never
	 * deletes a half-cleaned document. */
	readonly cleanup: (docId: number, actionId: string) => Effect.Effect<void, unknown>;
}

export class RichTextDeleteHooks extends Context.Service<
	RichTextDeleteHooks,
	RichTextDeleteHooksShape
>()("@ktb/rich-text/RichTextDeleteHooks") {}

export const RichTextDeleteHooksLive = Layer.effect(
	RichTextDeleteHooks,
	Effect.gen(function* () {
		const hooksRef = yield* Ref.make<ReadonlyArray<RichTextDeleteHook>>([]);

		return RichTextDeleteHooks.of({
			register: (hook) =>
				Ref.update(hooksRef, (hooks) => [...hooks.filter((h) => h.id !== hook.id), hook]),
			usage: Effect.fn("RichTextDeleteHooks.usage")(function* (docId: number) {
				const hooks = yield* Ref.get(hooksRef);
				const owners: RichTextUsageOwner[] = [];
				for (const hook of hooks) {
					const items = yield* hook.usage(docId);
					if (items.length > 0) owners.push({ id: hook.id, items });
				}
				return owners;
			}),
			cleanup: Effect.fn("RichTextDeleteHooks.cleanup")(function* (
				docId: number,
				actionId: string,
			) {
				const hooks = yield* Ref.get(hooksRef);
				for (const hook of hooks) {
					yield* hook.cleanup(docId, actionId);
				}
			}),
		});
	}),
);
