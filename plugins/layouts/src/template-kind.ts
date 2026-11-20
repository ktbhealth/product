import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Schema } from "effect";

import { TemplateKinds, type TemplateKind } from "@ktb/templates/kinds";

import { LayoutConfigSchema, type LayoutConfig } from "./service.ts";

/**
 * Server-side half of the `"layout"` template kind (P-107): the
 * descriptor registered into the shared `TemplateKinds` registry at
 * layer build. The payload is a JSON snapshot of everything needed to
 * recreate the layout — `{ name, description, config }` where `config`
 * is the PARSED layout config object (the `layouts.config` text
 * decoded, not the raw string), so a template stays readable JSON
 * end-to-end.
 *
 * `serialize` accepts the layout doc shape admin surfaces already
 * hold (`{ name, description?, config }` with `config` as raw JSON
 * text — the `LayoutDocWire`/`adminCreate` input form) and stores the
 * decoded config; `deserialize` inverts it back to that same source
 * form, which the caller feeds through `Layouts.adminCreate` (the
 * owning plugin's own admin-gated create path — templates never write
 * layout rows themselves). `validate` reports human-readable issues
 * for hand-authored payloads in the /platform/templates editor.
 */

/** The kind id consumers store on `templates.kind` — must stay in
 * sync with any client-side references to the layout kind. */
const LAYOUT_TEMPLATE_KIND = "layout";

/** Stored payload shape — `config` is the decoded `LayoutConfig`
 * object, `description` normalizes to `null` when absent. */
interface LayoutTemplatePayload {
	readonly name: string;
	readonly description: string | null;
	readonly config: LayoutConfig;
}

/** What `serialize` accepts / `deserialize` returns: the layout doc
 * fields with `config` as raw JSON text (the `adminCreate` input
 * contract). */
export interface LayoutTemplateSource {
	readonly name: string;
	readonly description?: string | null;
	readonly config: string;
}

const PayloadSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	config: Schema.Unknown,
});

const SourceSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	config: Schema.String,
});

const decodePayload = Schema.decodeUnknownSync(PayloadSchema);
const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const decodeConfig = Schema.decodeUnknownSync(LayoutConfigSchema);

/** Layout-doc source → stored payload: parse the raw config text into
 * the contract object so the payload is self-contained JSON. */
const serialize = (source: unknown): Effect.Effect<unknown, unknown> =>
	Effect.gen(function* () {
		const s = yield* Effect.try({
			try: () => decodeSource(source),
			catch: (error) => error,
		});
		const configJson: unknown = yield* Effect.try({
			try: () => JSON.parse(s.config),
			catch: (error) => error,
		});
		const config = yield* Effect.try({
			try: () => decodeConfig(configJson) as LayoutConfig,
			catch: (error) => error,
		});
		return {
			name: s.name,
			description: s.description ?? null,
			config,
		} satisfies LayoutTemplatePayload;
	});

/** Stored payload → layout-doc source: re-encode the parsed config
 * back to the raw JSON text `adminCreate`/`adminUpdate` expect. */
const deserialize = (payload: unknown): Effect.Effect<unknown, unknown> =>
	Effect.gen(function* () {
		const parsed = yield* Effect.try({
			try: () => decodePayload(payload),
			catch: (error) => error,
		});
		const config = yield* Effect.try({
			try: () => decodeConfig(parsed.config) as LayoutConfig,
			catch: (error) => error,
		});
		return {
			name: parsed.name,
			description: parsed.description ?? null,
			config: JSON.stringify(config),
		} satisfies LayoutTemplateSource;
	});

/** Issue-list validation for hand-authored payloads — empty means
 * storable. */
const validate = (payload: unknown): Effect.Effect<readonly string[], unknown> =>
	Effect.sync(() => {
		const issues: string[] = [];
		let parsed: ReturnType<typeof decodePayload> | null = null;
		try {
			parsed = decodePayload(payload);
		} catch {
			issues.push("payload must be an object with name, description and config");
		}
		if (parsed !== null) {
			try {
				decodeConfig(parsed.config);
			} catch {
				issues.push("config must be a valid layout config ({sections: [...]})");
			}
		}
		return issues;
	});

/** The registered descriptor — pure functions, no service capture. */
export const layoutTemplateKind: TemplateKind = {
	kind: LAYOUT_TEMPLATE_KIND,
	label: "Layout",
	serialize,
	deserialize,
	validate,
};

/**
 * Registration layer — merged into `layouts.services`. Consumes
 * `TemplateKinds` optionally: hosts without the templates plugin (or
 * with it disabled at composition time) build fine and register
 * nothing. The `optionalDeps` edge on `layouts.services` keeps
 * `templates.services` ordered first when both are installed.
 */
export const LayoutsTemplateKindLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const kinds = yield* Effect.serviceOption(TemplateKinds);
		if (Option.isNone(kinds)) return;
		yield* kinds.value.register(layoutTemplateKind);
	}),
);
