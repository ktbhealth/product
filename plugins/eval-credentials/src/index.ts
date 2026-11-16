import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyRoundIcon } from "lucide-react";

import { ApiKeys, type ApiKeyRow } from "@ktb/auth";
import { Principal, type Forbidden } from "@ktb/authz";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { EVAL_ACTION, EVAL_RESOURCE } from "@ktb/eval-validator";
import { Permissions } from "@ktb/rbac";

import { CredentialsPanelPage } from "./platform-page.tsx";

export interface CredentialCard {
	readonly id: string;
	readonly name: string;
	readonly provider: string;
	readonly masked: string;
}

const parseMeta = (raw: string | null): Record<string, unknown> => {
	if (raw === null) return {};
	try {
		const p: unknown = JSON.parse(raw);
		return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

const toCard = (row: ApiKeyRow): CredentialCard => {
	const meta = parseMeta(row.metadata);
	const provider = meta.provider;
	const secret = meta.secret;
	return {
		id: row.id,
		name: row.name ?? "credential",
		provider: typeof provider === "string" ? provider : "other",
		masked: typeof secret === "string" && secret.length > 4 ? `••••${secret.slice(-4)}` : "••••",
	};
};

const requireGrant = Effect.fn("EvalCredentials.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

/** Managed outbound credentials — backed by the better-auth apiKey
 * plugin via the `ApiKeys` port. Secrets never reach the wire:
 * `list` returns masked metadata; `resolve` is the only read-back
 * and stays server-side (consumed by endpoint resolution). */
export class EvalCredentials extends Context.Service<
	EvalCredentials,
	{
		readonly list: () => Effect.Effect<readonly CredentialCard[], Forbidden, unknown>;
		readonly create: (input: {
			readonly name: string;
			readonly provider: string;
			readonly secret: string;
		}) => Effect.Effect<{ readonly id: string }, Forbidden, unknown>;
		readonly remove: (id: string) => Effect.Effect<void, Forbidden, unknown>;
		/** Server-side only: raw secret for a `credential:<id>` ref. */
		readonly resolve: (ref: string) => Effect.Effect<string | null, Forbidden, unknown>;
	}
>()("@ktb/eval-credentials/EvalCredentials") {}

export const EvalCredentialsLive = Layer.effect(
	EvalCredentials,
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeys;
		return EvalCredentials.of({
			list: Effect.fn("EvalCredentials.list")(function* () {
				yield* requireGrant();
				const principal = yield* Principal;
				const refId = principal?.userId ?? "";
				const rows = yield* Effect.promise(() => apiKeys.list(refId));
				return rows.filter((r) => parseMeta(r.metadata).provider !== undefined).map(toCard);
			}),
			create: Effect.fn("EvalCredentials.create")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const refId = principal?.userId ?? "";
				return yield* Effect.promise(() =>
					apiKeys.create({
						name: input.name,
						referenceId: refId,
						metadata: { provider: input.provider, secret: input.secret },
					}),
				);
			}),
			remove: Effect.fn("EvalCredentials.remove")(function* (id) {
				yield* requireGrant();
				yield* Effect.promise(() => apiKeys.remove(id));
			}),
			resolve: Effect.fn("EvalCredentials.resolve")(function* (ref) {
				yield* requireGrant();
				const id = ref.replace(/^credential:/, "");
				return yield* Effect.promise(() => apiKeys.getSecret(id));
			}),
		});
	}),
);

export const evalCredentialsServicesPlugin = definePlugin({
	id: "eval.credentials.services",
	requiredDeps: [],
	services: EvalCredentialsLive,
});

export const evalCredentialsChromePlugin = definePlugin({
	id: "eval.credentials.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "eval-credentials.sidebar",
			region: "console.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval/credentials",
					label: "Credentials",
					icon: KeyRoundIcon,
					group: "Eval",
				},
			},
		},
	],
});

export const evalCredentialsPanelPlugin = definePlugin({
	id: "eval.credentials.panel",
	requiredDeps: [platformPanelPlugin.id, evalCredentialsServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "eval.credentials",
				path: "/platform/eval/credentials",
				component: CredentialsPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const creds = yield* EvalCredentials;
						return yield* creds
							.list()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as CredentialCard[])));
					}),
			},
		],
	},
});

export const plugins: readonly Plugin[] = [
	evalCredentialsServicesPlugin,
	evalCredentialsChromePlugin,
	evalCredentialsPanelPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"eval.credentials.services": true;
		"eval.credentials.chrome": true;
		"eval.credentials.panel": true;
	}
}
