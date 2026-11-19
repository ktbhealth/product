import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runAs, ensureSessionUser } from "@ktb/server-fns";

import { Fonts } from "./service.ts";
import type { FontFamilySummary, FontProviderConfig, FontProviderSummary } from "./types.ts";

/**
 * Fonts server functions — the admin surface behind
 * /platform/fonts/providers and /platform/fonts. Every call binds the
 * session user and re-checks PlatformAdmin inside the service; the
 * list fns degrade to empty payloads on Forbidden (the panel guard
 * 404s non-admins anyway — same contract as theme fns).
 */

/** Provider list for the providers page — non-admins get []. */
export const listFontProvidersFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly FontProviderSummary[]> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.listProviders();
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as FontProviderSummary[]))),
		);
	},
);

/** Registered adapter kinds for the add-provider picker — non-admins get []. */
export const listFontProviderKindsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly string[]> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.providerKinds();
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as string[]))),
		);
	},
);

const CreateInput = Schema.Struct({
	kind: Schema.String,
	name: Schema.String,
	config: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeCreate = Schema.decodeUnknownSync(CreateInput);

/** Create a provider — admin-gated inside the service; unknown kinds die. */
export const createFontProviderFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<FontProviderSummary> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.createProvider({
					kind: data.kind,
					name: data.name,
					config:
						data.config === undefined ? undefined : (data.config as FontProviderConfig | null),
				});
			}),
		);
	});

const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optional(Schema.String),
	config: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);

/** Patch provider name/config — `config: null` clears the stored JSON. */
export const updateFontProviderFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(async ({ data }): Promise<FontProviderSummary> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.updateProvider(data.id, {
					...(data.name === undefined ? {} : { name: data.name }),
					...(data.config === undefined
						? {}
						: { config: data.config as FontProviderConfig | null }),
				});
			}),
		);
	});

const EnabledInput = Schema.Struct({
	id: Schema.Number,
	enabled: Schema.Boolean,
});
const decodeEnabled = Schema.decodeUnknownSync(EnabledInput);

export const setFontProviderEnabledFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEnabled(input))
	.handler(async ({ data }): Promise<{ readonly ok: boolean }> => {
		const user = await ensureSessionUser();
		await runAs(
			user,
			Effect.flatMap(Fonts, (fonts) => fonts.setProviderEnabled(data.id, data.enabled)),
		);
		return { ok: true };
	});

const IdInput = Schema.Struct({ id: Schema.Number });
const decodeId = Schema.decodeUnknownSync(IdInput);

/** Hard-delete a provider — families cascade. Admin-gated inside. */
export const removeFontProviderFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<{ readonly ok: boolean }> => {
		const user = await ensureSessionUser();
		await runAs(
			user,
			Effect.flatMap(Fonts, (fonts) => fonts.removeProvider(data.id)),
		);
		return { ok: true };
	});

const FamiliesInput = Schema.Struct({
	providerId: Schema.optional(Schema.Number),
});
const decodeFamilies = Schema.decodeUnknownSync(FamiliesInput);

/** Synced family catalog — non-admins get []. */
export const listFontFamiliesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeFamilies(input))
	.handler(async ({ data }): Promise<readonly FontFamilySummary[]> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.listFamilies(data.providerId);
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as FontFamilySummary[]))),
		);
	});

/** Re-sync one provider's catalog from its adapter. Returns the
 * provider's family rows after the upsert. */
export const syncFontProviderFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<readonly FontFamilySummary[]> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const fonts = yield* Fonts;
				return yield* fonts.syncProvider(data.id);
			}),
		);
	});
