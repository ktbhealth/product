import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeyRoundIcon } from "lucide-react";

import { ApiKeys, type ApiKeyRow } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
// EVAL_ACTION/EVAL_RESOURCE are compile-time permission-string
// constants, not services — no dep edge on eval-validator: the rbac
// check degrades on its own when that plugin is absent.
import { EVAL_ACTION, EVAL_RESOURCE } from "@ktb/eval-validator";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { Secrets } from "@ktb/vault";

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
	// `list` strips `secret`; adapters store `secretLast4` as the only
	// displayable hint — rows predating it fall back to a bare mask.
	const last4 = meta.secretLast4;
	return {
		id: row.id,
		name: row.name ?? "credential",
		provider: typeof provider === "string" ? provider : "other",
		masked: typeof last4 === "string" && last4.length > 0 ? `••••${last4}` : "••••",
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
		// P-098 C3: the vault `user:<id>` scope is the canonical store —
		// new credentials land there; legacy `credential:` apiKey rows
		// still list/resolve/remove during the migration window.
		const secretsOpt = yield* Effect.serviceOption(Secrets);
		const secrets = Option.isSome(secretsOpt) ? secretsOpt.value : null;

		const userId = Effect.map(Principal, (p) => p?.userId ?? "");

		return Credentials.of({
			list: Effect.fn("Credentials.list")(function* () {
				yield* requireGrant();
				const uid = yield* userId;
				const rows = yield* Effect.promise(() => apiKeys.list(uid));
				// Strict marker: unrelated apikey rows (anything that sets a
				// `provider` key) must not leak into the credential surface.
				const legacy = rows.filter((r) => parseMeta(r.metadata).kind === "credential").map(toCard);
				if (secrets === null || uid === "") return legacy;
				const vaultRows = yield* secrets
					.list({ tenantId: null, userId: uid })
					.pipe(Effect.catch(() => Effect.succeed([] as const)));
				const managed = vaultRows.map((m) => ({
					id: String(m.id),
					name: m.name,
					provider: m.provider ?? "other",
					masked: m.hint !== null && m.hint !== "" ? `••••${m.hint}` : "••••",
				}));
				return [...legacy, ...managed];
			}),
			create: Effect.fn("Credentials.create")(function* (input) {
				yield* requireGrant();
				const uid = yield* userId;
				if (secrets !== null && uid !== "") {
					const meta = yield* secrets
						.put({
							tenantId: null,
							userId: uid,
							name: input.name,
							value: input.secret,
							provider: input.provider,
							kind: "api-key",
							hint: input.secret.slice(-4),
						})
						.pipe(
							Effect.catchTags({
								SecretError: () => Effect.fail(new Forbidden({ path: "credentials.create" })),
								TenantForbidden: () => Effect.fail(new Forbidden({ path: "credentials.create" })),
							}),
						);
					return { id: String(meta.id) };
				}
				return yield* Effect.promise(() =>
					apiKeys.create({
						name: input.name,
						referenceId: uid,
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
				// Vault rows have numeric ids; legacy apiKey ids are strings.
				if (secrets !== null && /^\d+$/.test(id)) {
					yield* secrets.remove({ id: Number(id) }).pipe(Effect.catch(() => Effect.void));
					return;
				}
				const uid = yield* userId;
				// Owner-scoped: another user's key id is a silent no-op.
				yield* Effect.promise(() => apiKeys.remove(id, uid));
			}),
			resolve: Effect.fn("Credentials.resolve")(function* (ref) {
				// `vault:` refs bypass the eval grant — they are the
				// capability model (system callers resolve server-side).
				if (ref.startsWith("vault:")) {
					if (secrets === null) return null;
					return yield* secrets.resolve(ref).pipe(Effect.catch(() => Effect.succeed(null)));
				}
				yield* requireGrant();
				// Only managed-credential refs read secrets back — bare
				// ids or env-var names are not credential refs.
				if (!ref.startsWith("credential:")) return null;
				const id = ref.slice("credential:".length);
				if (id === "") return null;
				// Numeric ids are vault rows; anything else is a legacy
				// apiKey id from the pre-vault credential store.
				if (secrets !== null && /^\d+$/.test(id)) {
					return yield* secrets
						.resolve(`vault:${id}`)
						.pipe(Effect.catch(() => Effect.succeed(null)));
				}
				const uid = yield* userId;
				return yield* Effect.promise(() => apiKeys.getSecret(id, uid));
			}),
		});
	}),
);

export const credentialsServicesPlugin = definePlugin({
	id: "credentials.services",
	meta: { keywords: ["eval", "credentials", "services"] },
	requiredDeps: [],
	// Vault user-scope secrets are the canonical store (P-098 C3) —
	// absence degrades to the legacy apiKey path only.
	optionalDeps: ["vault.secrets"],
	services: CredentialsLive,
});

export const credentialsChromePlugin = definePlugin({
	id: "credentials.chrome",
	i18nKeys: {
		groups: { Identity: "panel_group_identity" },
	},
	meta: { keywords: ["eval", "credentials", "ui"] },
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
					group: "Identity",
				},
			},
		},
	],
});

export const credentialsPanelPlugin = definePlugin({
	id: "credentials.panel",
	meta: { keywords: ["eval", "credentials", "ui"] },
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
