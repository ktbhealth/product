import type { Json } from "effect/Schema";

/**
 * Wire DTOs for the fonts plugin — the shapes server fns and panel
 * pages exchange. Provider `kind` is intentionally an open string: the
 * adapter registry is extensible, so new kinds never require a schema
 * or type change here.
 */

/** Registered adapter kind — open string ("local", "googlefonts", …). */
export type FontProviderKind = string;

/** Adapter-owned provider configuration — opaque JSON at the port. */
export type FontProviderConfig = Record<string, Json>;

export interface FontProviderSummary {
	readonly id: number;
	readonly kind: FontProviderKind;
	readonly name: string;
	readonly config?: FontProviderConfig | null;
	readonly enabled: boolean;
	readonly familyCount: number;
	readonly createdAt: string;
	readonly updatedAt: string | null;
}

export const FONT_FAMILY_STATUSES = ["pending", "ready", "failed"] as const;
export type FontFamilyStatus = (typeof FONT_FAMILY_STATUSES)[number];

export interface FontFamilySummary {
	readonly id: number;
	readonly providerId: number;
	readonly family: string;
	readonly weights: readonly number[];
	readonly status: FontFamilyStatus;
	readonly meta?: Record<string, Json> | null;
}
