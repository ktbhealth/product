import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyRoundIcon } from "lucide-react";

import { ApiKeys, type ApiKeyRow } from "@ktb/auth";
import { Principal, type Forbidden } from "@ktb/authz";
import { EVAL_ACTION, EVAL_RESOURCE } from "@ktb/eval-validator";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
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

const requireGrant = Effect.fn("Credentials.gate")(function* () {
	const permissions = yield* Permissions;
	yield* permissions.requirePermission(EVAL_RESOURCE, EVAL_ACTION);
});

/** Managed outbound credentials — backed by the better-auth apiKey
 * plugin via the `ApiKeys` port. Secrets never reach the wire:
 * `list` returns masked metadata; `resolve` is the only read-back
 * and stays server-side (consumed by endpoint resolution). */
export class Credentials extends Context.Service<
	Credentials,
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
>()("@ktb/credentials/Credentials") {}

export const CredentialsLive = Layer.effect(
	Credentials,
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeys;
		return Credentials.of({
			list: Effect.fn("Credentials.list")(function* () {
				yield* requireGrant();
				const principal = yield* Principal;
				const refId = principal?.userId ?? "";
				const rows = yield* Effect.promise(() => apiKeys.list(refId));
				// Strict marker: unrelated apikey rows (anything that sets a
				// `provider` key) must not leak into the credential surface.
				return rows.filter((r) => parseMeta(r.metadata).kind === "credential").map(toCard);
			}),
			create: Effect.fn("Credentials.create")(function* (input) {
				yield* requireGrant();
				const principal = yield* Principal;
				const refId = principal?.userId ?? "";
				return yield* Effect.promise(() =>
					apiKeys.create({
						name: input.name,
						referenceId: refId,
						metadata: {
							kind: "credential",
							provider: input.provider,
							secret: input.secret,
						},
					}),
				);
			}),
			remove: Effect.fn("Credentials.remove")(function* (id) {
				yield* requireGrant();
				const principal = yield* Principal;
				// Owner-scoped: another user's key id is a silent no-op.
				yield* Effect.promise(() => apiKeys.remove(id, principal?.userId ?? ""));
			}),
			resolve: Effect.fn("Credentials.resolve")(function* (ref) {
				yield* requireGrant();
				// Only managed-credential refs read secrets back — bare
				// ids or env-var names are not credential refs.
				if (!ref.startsWith("credential:")) return null;
				const id = ref.slice("credential:".length);
				if (id === "") return null;
				const principal = yield* Principal;
				return yield* Effect.promise(() => apiKeys.getSecret(id, principal?.userId ?? ""));
			}),
		});
	}),
);

export const credentialsServicesPlugin = definePlugin({
	id: "credentials.services",
	requiredDeps: [],
	services: CredentialsLive,
});

export const credentialsChromePlugin = definePlugin({
	id: "credentials.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "credentials.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/ai/credentials",
					label: "Credentials",
					icon: KeyRoundIcon,
					group: "AI",
				},
			},
		},
	],
});

export const credentialsPanelPlugin = definePlugin({
	id: "credentials.panel",
	requiredDeps: [platformPanelPlugin.id, credentialsServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "credentials",
				path: "/platform/ai/credentials",
				component: CredentialsPanelPage,
				guard: () =>
					Effect.gen(function* () {
						const permissions = yield* Permissions;
						return yield* permissions.can(EVAL_RESOURCE, EVAL_ACTION);
					}),
				loader: () =>
					Effect.gen(function* () {
						const creds = yield* Credentials;
						return yield* creds
							.list()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as CredentialCard[])));
					}),
			},
		],
	},
});

export const plugins: readonly Plugin[] = [
	credentialsServicesPlugin,
	credentialsChromePlugin,
	credentialsPanelPlugin,
];

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"credentials.services": true;
		"credentials.chrome": true;
		"credentials.panel": true;
	}
}
