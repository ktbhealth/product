import * as Schema from "effect/Schema";

import { Event } from "@effect-server-utils/cqrs";

/**
 * Fonts change events — published on the app-wide `EventBus` after
 * every committed provider/family mutation (see service.ts).
 * Consumers subscribe via `EventBus.stream`/`subscribeAfterCommit`;
 * the bus needs no enumeration — events are plain data routed by
 * `_tag`. Payloads mirror {@link FontHookHandle} minus the family
 * list: hooks get the detail, bus events stay minimal.
 */

/** A `font_providers` row was created, updated, enabled/disabled or
 * removed. */
export const FontsProviderChanged = Event.make("fonts.provider.changed", {
	providerId: Schema.Number,
	kind: Schema.String,
});

/** A provider's `font_families` catalog was re-synced from its
 * adapter. */
export const FontsFamilySynced = Event.make("fonts.family.synced", {
	providerId: Schema.Number,
	kind: Schema.String,
});

/** Decoded payload types — what subscribers receive. */
export type FontsProviderChangedEvent = Event.Type<typeof FontsProviderChanged>;
export type FontsFamilySyncedEvent = Event.Type<typeof FontsFamilySynced>;

/** The bus tags subscribers filter on (`EventBus.stream([tag])`). */
export const FONTS_PROVIDER_CHANGED_TAG = FontsProviderChanged.tag;
export const FONTS_FAMILY_SYNCED_TAG = FontsFamilySynced.tag;
