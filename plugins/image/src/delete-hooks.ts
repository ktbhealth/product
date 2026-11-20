import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Delete-time referencer hooks for media-library images (P-111) — the
 * same contract `RichTextDeleteHooks` established, keyed on the image
 * row id instead of a document id. Other plugins register an
 * `ImageDeleteHook` at layer build (via `Effect.serviceOption` — the
 * image plugin never imports them, keeping the dependency direction
 * one-way: consumers depend on image, never the reverse). The
 * registry answers two questions for the admin delete flow:
 *
 * - `usage(imageId)` — which plugins reference the image and what the
 *   referents are (drives the confirmation dialog);
 * - `cleanup(imageId, actionId)` — run every hook's cleanup with the
 *   action the admin picked; each hook no-ops on action ids it does
 *   not own, so one dialog choice can cascade through several plugins.
 *
 * Unlike rich-text there is no FK backstop on arbitrary referencers —
 * referencers store the image id inside their own payloads — so a hook
 * that fails or is absent leaves a dangling reference. `usage` errors
 * therefore propagate (a hidden referencer is worse than a failed
 * dialog) and the delete fn aborts before touching the row.
 */

/** One thing referencing the image — serializable so it can cross the
 * server-fn boundary into the dialog. `path` is an optional link target
 * (e.g. the page's public path). */
export interface ImageReferencerItem {
	readonly id: number | string;
	readonly title: string;
	readonly path?: string;
}

/** Per-plugin usage group: `id` is the hook id (also the `owner` the
 * plugin's contributed `dialogAction` chrome entries in the
 * `image.delete.actions` region declare). */
export interface ImageUsageOwner {
	readonly id: string;
	readonly items: readonly ImageReferencerItem[];
}

/** A plugin's participation in image deletion. `usage` returns the
 * referents for `imageId` (empty = not referenced); `cleanup` performs
 * the admin-chosen `actionId` — hooks MUST succeed silently for action
 * ids they do not own. Both run with the hook's own captured deps, so
 * their Effect requirements stay `never`. */
export interface ImageDeleteHook {
	readonly id: string;
	readonly usage: (imageId: number) => Effect.Effect<readonly ImageReferencerItem[], unknown>;
	readonly cleanup: (imageId: number, actionId: string) => Effect.Effect<void, unknown>;
}

export class ImageDeleteHooks extends Context.Service<
	ImageDeleteHooks,
	{
		/** Register a hook; re-registering the same `id` replaces the
		 * previous entry (layer rebuilds stay idempotent). */
		readonly register: (hook: ImageDeleteHook) => Effect.Effect<void>;
		/** Referencers grouped by hook id — owners with zero items are
		 * omitted. Hook failures propagate (a hidden referencer is
		 * worse than a failed dialog). */
		readonly usage: (imageId: number) => Effect.Effect<readonly ImageUsageOwner[], unknown>;
		/** Run every registered hook's `cleanup` for `actionId`,
		 * sequentially; the first failure aborts so the caller never
		 * deletes a half-cleaned image. */
		readonly cleanup: (imageId: number, actionId: string) => Effect.Effect<void, unknown>;
	}
>()("@ktb/image/ImageDeleteHooks") {}

export const ImageDeleteHooksLive = Layer.effect(
	ImageDeleteHooks,
	Effect.gen(function* () {
		const hooksRef = yield* Ref.make<ReadonlyArray<ImageDeleteHook>>([]);

		return ImageDeleteHooks.of({
			register: (hook) =>
				Ref.update(hooksRef, (hooks) => [...hooks.filter((h) => h.id !== hook.id), hook]),
			usage: Effect.fn("ImageDeleteHooks.usage")(function* (imageId: number) {
				const hooks = yield* Ref.get(hooksRef);
				const owners: ImageUsageOwner[] = [];
				for (const hook of hooks) {
					const items = yield* hook.usage(imageId);
					if (items.length > 0) owners.push({ id: hook.id, items });
				}
				return owners;
			}),
			cleanup: Effect.fn("ImageDeleteHooks.cleanup")(function* (imageId: number, actionId: string) {
				const hooks = yield* Ref.get(hooksRef);
				for (const hook of hooks) {
					yield* hook.cleanup(imageId, actionId);
				}
			}),
		});
	}),
);
