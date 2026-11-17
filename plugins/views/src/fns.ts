import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { getSessionUser, run, runAs } from "@ktb/server-fns";

import type { ViewQueryInput } from "./plan.ts";
import { Views } from "./service.ts";
import type { ViewPageWire } from "./wire.ts";

export type { ViewPageWire, ViewListWire, ViewDetailWire, ViewRecordWire } from "./wire.ts";

// Views server functions: `viewQueryFn` re-queries a list view's
// payload for pagination/filter changes after the initial page
// loader. Session-OPTIONAL like the app-page dispatch itself — views
// without a `permission` are public, so anonymous callers run under
// `run` (no bound Principal) exactly like `appPageDataFn`; a def's
// permission check inside `Views.query` fails closed either way.
// Handled store failures (unknown collection) collapse to null — the
// same "not visible" contract the page loader uses; other errors
// propagate.

const QueryInput = Schema.Struct({
	path: Schema.String,
	offset: Schema.optionalKey(Schema.Number),
	values: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const decodeQuery = Schema.decodeUnknownSync(QueryInput);

const HANDLED_TAGS = ["UnknownCollection"] as const;

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(HANDLED_TAGS as readonly string[]).includes(String((error as { _tag?: unknown })._tag));

/** Re-query a view's list payload. `path` is the view's mount path
 * (`/v/<key>`); `values` carries raw search-param strings for the
 * def's declared interactive filters — the service re-validates them
 * against the def (undeclared params are ignored) and the store
 * re-validates the resulting filter. `null` for unknown/forbidden
 * views, detail paths and unregistered collections. */
export const viewQueryFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeQuery(input))
	.handler(async ({ data }): Promise<ViewPageWire | null> => {
		const user = await getSessionUser();
		const input: ViewQueryInput = {
			...(data.offset === undefined ? {} : { offset: data.offset }),
			...(data.values === undefined ? {} : { values: data.values }),
		};
		const effect = Effect.flatMap(Views, (views) => views.query(data.path, input));
		const promise = user === null ? run(effect) : runAs(user, effect);
		return promise.catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
	});
