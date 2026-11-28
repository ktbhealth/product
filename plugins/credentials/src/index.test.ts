import { describe, expect, it } from "vitest";

import { ApiKeys, type ApiKeyRow } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { SecretError, Secrets, SecretsLive } from "@ktb/vault";
import { secretKeyringLive } from "@ktb/vault-keyring";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	Credentials,
	CredentialsLive,
	credentialsChromePlugin,
	credentialsPanelPlugin,
	credentialsServicesPlugin,
	plugins,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";
import * as schemaModule from "./schema.ts";

const grantLayer = (allow: boolean) =>
	Layer.succeed(
		Permissions,
		Permissions.of({
			permissionsFor: () => Effect.succeed(new Map()),
			canFor: () => Effect.succeed(allow),
			can: () => Effect.succeed(allow),
			requirePermissionFor: () =>
				allow ? Effect.void : Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
			requirePermission: () =>
				allow ? Effect.void : Effect.fail(new Forbidden({ path: "rbac.eval.validator" })),
			invalidate: () => Effect.void,
		} as never),
	);

interface SeedRow {
	readonly row: ApiKeyRow;
	readonly referenceId: string;
}

const row = (
	id: string,
	metadata: string | null,
	name: string | null = `name-${id}`,
): ApiKeyRow => ({
	id,
	referenceId: "u1",
	name,
	start: "sk",
	enabled: true,
	metadata,
});

/** Mirrors the real adapter's `create`: a string secret longer than
 * 4 chars also stores a non-sensitive `secretLast4` hint. */
const withLast4Hint = (metadata: Record<string, unknown>) => {
	const secret = metadata.secret;
	return typeof secret === "string" && secret.length > 4
		? { ...metadata, secretLast4: secret.slice(-4) }
		: metadata;
};

/** Mirrors the real adapter's `list`: `secret` never leaves the port. */
const stripSecret = (raw: string | null): string | null => {
	if (raw === null) return null;
	try {
		const p: unknown = JSON.parse(raw);
		if (typeof p !== "object" || p === null || Array.isArray(p)) return "{}";
		const { secret: _secret, ...rest } = p as Record<string, unknown>;
		return JSON.stringify(rest);
	} catch {
		return "{}";
	}
};

/** In-memory ApiKeys port — mirrors the adapter contract: rows are
 * per-`referenceId`, `metadata` is a JSON string, `getSecret` reads
 * `metadata.secret` back. */
const makeApiKeys = (seed: readonly SeedRow[] = []) => {
	const store = new Map<string, SeedRow>(seed.map((s) => [s.row.id, s]));
	let n = 0;
	const created: { name: string; referenceId: string; metadata: Record<string, unknown> }[] = [];
	const shape = {
		create: async (input: {
			name: string;
			referenceId: string;
			metadata: Record<string, unknown>;
		}) => {
			created.push(input);
			n += 1;
			const id = `k${n}`;
			store.set(id, {
				row: {
					id,
					referenceId: input.referenceId,
					name: input.name,
					start: "sk",
					enabled: true,
					metadata: JSON.stringify(withLast4Hint(input.metadata)),
				},
				referenceId: input.referenceId,
			});
			return { id };
		},
		list: async (referenceId: string) =>
			[...store.values()]
				.filter((s) => s.referenceId === referenceId)
				.map((s) => ({ ...s.row, metadata: stripSecret(s.row.metadata) })),
		remove: async (keyId: string, referenceId: string) => {
			if (store.get(keyId)?.referenceId === referenceId) store.delete(keyId);
		},
		getSecret: async (keyId: string, referenceId: string) => {
			const entry = store.get(keyId);
			if (entry === undefined || entry.referenceId !== referenceId) return null;
			const raw = entry.row.metadata;
			if (raw === null || raw === undefined) return null;
			try {
				const parsed = JSON.parse(raw) as { secret?: unknown };
				return typeof parsed.secret === "string" ? parsed.secret : null;
			} catch {
				return null;
			}
		},
	};
	return { store, created, layer: Layer.succeed(ApiKeys, ApiKeys.of(shape)) };
};

const make = (
	opts: {
		allow?: boolean;
		seed?: readonly SeedRow[];
		extra?: readonly Layer.Layer<unknown>[];
	} = {},
) => {
	const { allow = true, seed = [], extra = [] } = opts;
	const apiKeys = makeApiKeys(seed);
	const layers = Layer.mergeAll(apiKeys.layer, grantLayer(allow), ...extra);
	const rt = ManagedRuntime.make(Layer.merge(CredentialsLive.pipe(Layer.provide(layers)), layers));
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>, userId: string | null = "u1") =>
		rt.runPromise(
			Effect.provideService(
				effect,
				Principal,
				userId === null ? null : { userId, email: "v@x.com" },
			) as Effect.Effect<A, E>,
		);
	return { rt, run, apiKeys };
};

describe("Credentials", () => {
	it("creates with provider+secret metadata, lists masked and removes", async () => {
		const { rt, run, apiKeys } = make();
		const { id } = await run(
			Effect.flatMap(Credentials, (s) =>
				s.create({ name: "prod key", provider: "openai", secret: "sk-live-1234" }),
			),
		);
		expect(id).toBe("k1");
		expect(apiKeys.created[0]).toEqual({
			name: "prod key",
			referenceId: "u1",
			metadata: { kind: "credential", provider: "openai", secret: "sk-live-1234" },
		});

		const listed = await run(Effect.flatMap(Credentials, (s) => s.list()));
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe("k1");
		expect(listed[0]?.name).toBe("prod key");
		expect(listed[0]?.provider).toBe("openai");
		expect(listed[0]?.masked).toBe("••••1234");

		await run(Effect.flatMap(Credentials, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(Credentials, (s) => s.list()))).toHaveLength(0);
		await rt.dispose();
	});

	it("scopes list/create to the principal's referenceId", async () => {
		const { rt, run } = make({
			seed: [
				{ row: row("other-1", '{"provider":"openai","secret":"sk-9999"}'), referenceId: "u2" },
			],
		});
		expect(await run(Effect.flatMap(Credentials, (s) => s.list()))).toHaveLength(0);
		// No principal → empty referenceId.
		expect(
			await run(
				Effect.flatMap(Credentials, (s) => s.list()),
				null,
			),
		).toHaveLength(0);
		await run(
			Effect.flatMap(Credentials, (s) => s.create({ name: "k", provider: "openai", secret: "s" })),
			null,
		);
		expect(
			await run(
				Effect.flatMap(Credentials, (s) => s.list()),
				null,
			),
		).toHaveLength(1);
		await rt.dispose();
	});

	it("masks edge metadata — short/missing secrets, non-string provider, null name", async () => {
		const { rt, run } = make({
			seed: [
				{
					row: row("a", '{"kind":"credential","provider":"gemini","secret":"abc"}'),
					referenceId: "u1",
				},
				{
					row: row("b", '{"kind":"credential","provider":"anthropic"}', null),
					referenceId: "u1",
				},
				{
					row: row(
						"c",
						'{"kind":"credential","provider":42,"secret":"sk-77777","secretLast4":"7777"}',
					),
					referenceId: "u1",
				},
				// Legacy row: secret stored before `secretLast4` existed —
				// `list` strips it, so only a bare mask survives.
				{
					row: row("h", '{"kind":"credential","provider":"x","secret":"sk-legacy"}'),
					referenceId: "u1",
				},
				// Unmarked rows — even ones carrying provider/secret-shaped
				// metadata — are not eval credentials and never list.
				{ row: row("d", '{"provider":"openai","secret":"sk-99999"}'), referenceId: "u1" },
				{ row: row("e", "not-json"), referenceId: "u1" },
				{ row: row("f", "5"), referenceId: "u1" },
				{ row: row("g", null), referenceId: "u1" },
			],
		});
		const listed = await run(Effect.flatMap(Credentials, (s) => s.list()));
		const byId = new Map(listed.map((c) => [c.id, c] as const));
		expect(byId.get("a")?.masked).toBe("••••");
		expect(byId.get("b")?.masked).toBe("••••");
		expect(byId.get("b")?.name).toBe("credential");
		expect(byId.get("c")?.provider).toBe("other");
		expect(byId.get("c")?.masked).toBe("••••7777");
		expect(byId.get("h")?.masked).toBe("••••");
		// Rows without the kind marker are not managed credentials at all.
		expect(byId.has("d")).toBe(false);
		expect(byId.has("e")).toBe(false);
		expect(byId.has("f")).toBe(false);
		expect(byId.has("g")).toBe(false);
		await rt.dispose();
	});

	it("tolerates ApiKeys impls returning non-JSON or null-literal metadata", async () => {
		// The in-memory mock normalizes bad metadata to "{}" like the real
		// adapter — this raw stub exercises parseMeta's defensive paths.
		const apiKeys = ApiKeys.of({
			create: async () => ({ id: "k" }),
			list: async () => [
				row("x1", "not-json{{"),
				row("x2", "null"),
				row("x3", '{"kind":"credential","provider":"p"}'),
			],
			remove: async () => {},
			getSecret: async () => null,
		});
		const layers = Layer.mergeAll(Layer.succeed(ApiKeys, apiKeys), grantLayer(true));
		const rt = ManagedRuntime.make(
			Layer.merge(CredentialsLive.pipe(Layer.provide(layers)), layers),
		);
		const listed = await rt.runPromise(
			Effect.provideService(
				Effect.flatMap(Credentials, (s) => s.list()),
				Principal,
				{ userId: "u1", email: "v@x.com" },
			) as Effect.Effect<unknown, unknown>,
		);
		expect(listed).toHaveLength(1);
		expect((listed as { id: string }[])[0]?.id).toBe("x3");
		await rt.dispose();
	});

	it("resolve returns the raw secret for credential:<id> refs", async () => {
		const { rt, run } = make({
			seed: [
				{ row: row("k1", '{"provider":"gemini","secret":"sekret"}'), referenceId: "u1" },
				{ row: row("k2", '{"provider":"openai","secret":7}'), referenceId: "u1" },
				{ row: row("k3", null), referenceId: "u1" },
			],
		});
		const resolve = (ref: string) => run(Effect.flatMap(Credentials, (s) => s.resolve(ref)));
		expect(await resolve("credential:k1")).toBe("sekret");
		expect(await resolve("credential:missing")).toBeNull();
		expect(await resolve("credential:k2")).toBeNull();
		expect(await resolve("credential:k3")).toBeNull();
		// Bare ids and env-var names are not credential refs — the
		// `credential:` prefix is required, and a bare prefix is empty.
		expect(await resolve("ENV_VAR")).toBeNull();
		expect(await resolve("k1")).toBeNull();
		expect(await resolve("credential:")).toBeNull();
		await rt.dispose();
	});

	it("resolve returns null for vault: refs when no Secrets service is bound", async () => {
		const { rt, run } = make();
		expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("vault:1")))).toBeNull();
		await rt.dispose();
	});

	it("resolve and remove cannot reach another user's key", async () => {
		const { rt, run, apiKeys } = make({
			seed: [
				{
					row: row("other-1", '{"kind":"credential","provider":"openai","secret":"sk-9999"}'),
					referenceId: "u2",
				},
			],
		});
		// Acting as u1 on u2's key id: the secret is invisible and the
		// delete is a no-op — the row survives untouched.
		expect(
			await run(Effect.flatMap(Credentials, (s) => s.resolve("credential:other-1"))),
		).toBeNull();
		await run(Effect.flatMap(Credentials, (s) => s.remove("other-1")));
		expect(apiKeys.store.has("other-1")).toBe(true);
		// ...while the owner can still resolve it.
		expect(
			await run(
				Effect.flatMap(Credentials, (s) => s.resolve("credential:other-1")),
				"u2",
			),
		).toBe("sk-9999");
		await rt.dispose();
	});

	it("resolve and remove fall back to the empty referenceId without a principal", async () => {
		const { rt, run, apiKeys } = make({
			seed: [
				{
					row: row("orphan", '{"kind":"credential","provider":"x","secret":"sk-1"}'),
					referenceId: "",
				},
			],
		});
		// No principal in scope → `?? ""` arm: rows owned by the empty
		// referenceId are reachable, everyone else's are not.
		expect(
			await run(
				Effect.flatMap(Credentials, (s) => s.resolve("credential:orphan")),
				null,
			),
		).toBe("sk-1");
		await run(
			Effect.flatMap(Credentials, (s) => s.remove("orphan")),
			null,
		);
		expect(apiKeys.store.has("orphan")).toBe(false);
		await rt.dispose();
	});

	it("denies everything without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(Credentials, (s) => s.list()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(
				Effect.flatMap(Credentials, (s) =>
					s.create({ name: "k", provider: "openai", secret: "s" }),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(run(Effect.flatMap(Credentials, (s) => s.remove("k1")))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(Effect.flatMap(Credentials, (s) => s.resolve("credential:k1"))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});
});

describe("credentials plugin manifests", () => {
	it("registers services, chrome and the panel page — no tables", () => {
		expect(credentialsServicesPlugin.id).toBe("credentials.services");
		expect(credentialsServicesPlugin.requiredDeps).toEqual([]);
		expect((credentialsServicesPlugin as { readonly tables?: unknown }).tables).toBeUndefined();
		expect(credentialsChromePlugin.id).toBe("credentials.chrome");
		expect(credentialsChromePlugin.chrome?.[0]?.id).toBe("credentials.sidebar");
		expect(credentialsPanelPlugin.requiredDeps).toContain("credentials.services");
		expect(plugins).toHaveLength(3);
	});

	it("panel guard reflects the grant and loader degrades to []", async () => {
		const page = credentialsPanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("credentials");
		expect(page?.path).toBe("/platform/ai/credentials");
		for (const allow of [true, false]) {
			const { rt } = make({ allow });
			expect(await rt.runPromise(page!.guard!() as Effect.Effect<boolean>)).toBe(allow);
			const data = await rt.runPromise(page!.loader!() as Effect.Effect<readonly unknown[]>);
			expect(data).toEqual([]);
			await rt.dispose();
		}
	});

	it("panel loader lists credentials", async () => {
		const { rt, run } = make();
		await run(
			Effect.flatMap(Credentials, (s) =>
				s.create({ name: "k", provider: "openai", secret: "s12345" }),
			),
		);
		const page = credentialsPanelPlugin.panel!.pages![0]!;
		const data = await run(page.loader!() as Effect.Effect<readonly unknown[], never, unknown>);
		expect(data).toHaveLength(1);
		await rt.dispose();
	});
});

describe("client plugin mirror", () => {
	it("mirrors the client-safe plugin ids, sidebar item, and panel page", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"credentials.services",
			"credentials.chrome",
			"credentials.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "credentials.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["credentials.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "credentials.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/credentials"]);
	});

	it("keeps the schema module table-free — credentials live in apikey", () => {
		expect(Object.keys(schemaModule)).toHaveLength(0);
	});
});

describe("Credentials (vault-backed, P-098 C3)", () => {
	it("stores new credentials as vault user secrets; credential: refs resolve", async () => {
		const db = makeDb(makeTestD1());
		const secretsEnv = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(""))),
			secretKeyringLive("0".repeat(64)) as Layer.Layer<unknown>,
		);
		const secretsLayer = SecretsLive.pipe(Layer.provide(secretsEnv)) as unknown as Layer.Layer<
			unknown,
			never,
			never
		>;
		const apiKeys = makeApiKeys([]);
		const layers = Layer.mergeAll(apiKeys.layer, grantLayer(true), secretsLayer);
		const rt = ManagedRuntime.make(
			Layer.merge(CredentialsLive.pipe(Layer.provide(layers)), layers) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			rt.runPromise(
				Effect.provideService(effect, Principal, {
					userId: "u1",
					email: "v@x.com",
				}) as Effect.Effect<A, E>,
			);

		const { id } = await run(
			Effect.flatMap(Credentials, (s) =>
				s.create({ name: "prod key", provider: "openai", secret: "sk-live-9876" }),
			),
		);
		expect(id).toMatch(/^\d+$/);
		// Vault path taken — nothing landed in the legacy apiKey store.
		expect(apiKeys.created).toHaveLength(0);

		const listed = await run(Effect.flatMap(Credentials, (s) => s.list()));
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id,
			name: "prod key",
			provider: "openai",
			masked: "••••9876",
		});
		// Metadata never carries the secret.
		expect(JSON.stringify(listed)).not.toContain("sk-live-9876");

		// Both ref spellings resolve server-side.
		expect(await run(Effect.flatMap(Credentials, (s) => s.resolve(`credential:${id}`)))).toBe(
			"sk-live-9876",
		);
		expect(await run(Effect.flatMap(Credentials, (s) => s.resolve(`vault:${id}`)))).toBe(
			"sk-live-9876",
		);

		// `credential:<id>` stays owner-scoped: vault row ids are global
		// across scopes, so another user's secret — or a non-credential
		// row in the caller's own scope is fine, but u2's row is not —
		// resolves null even though u2 holds the eval grant.
		const runAs = <A, E>(effect: Effect.Effect<A, E, unknown>, userId: string) =>
			rt.runPromise(
				Effect.provideService(effect, Principal, {
					userId,
					email: `${userId}@x.com`,
				}) as Effect.Effect<A, E>,
			);
		const foreign = await runAs(
			Effect.flatMap(Secrets, (s) =>
				s.put({ tenantId: null, userId: "u2", name: "u2-key", value: "u2-secret" }),
			),
			"u2",
		);
		expect(
			await runAs(
				Effect.flatMap(Credentials, (s) => s.resolve(`credential:${foreign.id}`)),
				"u1",
			),
		).toBeNull();
		// The owner still resolves their own row through the same ref.
		expect(
			await runAs(
				Effect.flatMap(Credentials, (s) => s.resolve(`credential:${foreign.id}`)),
				"u2",
			),
		).toBe("u2-secret");
		// No principal → empty uid → fail closed.
		expect(
			await rt.runPromise(
				Effect.flatMap(Credentials, (s) => s.resolve(`credential:${id}`)) as Effect.Effect<
					string | null
				>,
			),
		).toBeNull();

		await run(Effect.flatMap(Credentials, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(Credentials, (s) => s.list()))).toHaveLength(0);

		// Failure fallbacks: unknown vault ids are silent no-ops, and a
		// blank-after-trim name maps the service's SecretError to
		// Forbidden at the credentials boundary.
		await run(Effect.flatMap(Credentials, (s) => s.remove("999999")));
		expect(
			await run(Effect.flatMap(Credentials, (s) => s.resolve("credential:999999"))),
		).toBeNull();
		expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("vault:999999")))).toBeNull();
		await expect(
			run(
				Effect.flatMap(Credentials, (s) =>
					s.create({ name: "   ", provider: "openai", secret: "s" }),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });

		// Vault rows without provider/hint degrade to "other"/bare mask.
		await run(
			Effect.flatMap(Secrets, (s) =>
				s.put({ tenantId: null, userId: "u1", name: "bare", value: "x" }),
			),
		);
		await run(
			Effect.flatMap(Secrets, (s) =>
				s.put({ tenantId: null, userId: "u1", name: "empty-hint", value: "x", hint: "" }),
			),
		);
		const merged = await run(Effect.flatMap(Credentials, (s) => s.list()));
		const bare = merged.find((c) => c.name === "bare");
		const emptyHint = merged.find((c) => c.name === "empty-hint");
		expect(bare).toMatchObject({ provider: "other", masked: "••••" });
		expect(emptyHint?.masked).toBe("••••");
		await rt.dispose();
	});

	it("degrades Secrets failures: list falls back, create maps to Forbidden", async () => {
		const meta = (id: number, over: Record<string, unknown> = {}) =>
			({
				id,
				scope: "user:u1",
				tenantId: null,
				name: `s${id}`,
				provider: null,
				kind: "api-key",
				hint: null,
				version: 1,
				status: "active",
				kekVersion: null,
				createdBy: "u1",
				createdAt: new Date(0),
				updatedAt: null,
				rotatedAt: null,
				...over,
			}) as never;
		const stub = (shape: Record<string, unknown>) =>
			Layer.succeed(Secrets, {
				list: () => Effect.succeed([]),
				put: () => Effect.succeed({} as never),
				resolve: () => Effect.succeed(null),
				remove: () => Effect.void,
				rotate: () => Effect.succeed({} as never),
				...shape,
			} as never) as Layer.Layer<unknown>;

		// list merges vault metadata — provider/hint fallbacks — and a
		// failing list degrades to the legacy rows only.
		{
			const { rt, run } = make({
				extra: [
					stub({
						list: () =>
							Effect.succeed([
								meta(1, { name: "vp-null", provider: null, hint: null }),
								meta(2, { name: "vp-empty", provider: "aws", hint: "" }),
								meta(3, { name: "vp-hint", provider: "gcp", hint: "9" }),
							]),
					}),
				],
			});
			const listed = await run(Effect.flatMap(Credentials, (s) => s.list()));
			const byName = new Map(listed.map((c) => [c.name, c] as const));
			expect(byName.get("vp-null")).toMatchObject({ provider: "other", masked: "••••" });
			expect(byName.get("vp-empty")?.masked).toBe("••••");
			expect(byName.get("vp-hint")).toMatchObject({ provider: "gcp", masked: "••••9" });
			await rt.dispose();
		}
		{
			const { rt, run } = make({
				seed: [
					{
						row: row("leg", '{"kind":"credential","provider":"x","secret":"s"}'),
						referenceId: "u1",
					},
				],
				extra: [stub({ list: () => Effect.fail(new SecretError({ reason: "invalid" })) })],
			});
			const listed = await run(Effect.flatMap(Credentials, (s) => s.list()));
			expect(listed.map((c) => c.id)).toEqual(["leg"]);
			await rt.dispose();
		}

		// create maps both vault error tags to Forbidden.
		for (const tag of ["SecretError", "TenantForbidden"] as const) {
			const { rt, run } = make({
				extra: [
					stub({
						put: () =>
							Effect.fail(
								tag === "SecretError"
									? new SecretError({ reason: "invalid" })
									: ({ _tag: tag, path: "vault.secret" } as never),
							),
					}),
				],
			});
			await expect(
				run(
					Effect.flatMap(Credentials, (s) =>
						s.create({ name: "k", provider: "openai", secret: "s" }),
					),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
			await rt.dispose();
		}

		// remove/resolve swallow vault failures; credential:<numeric>
		// refs route through the vault resolver.
		{
			const failing = new SecretError({ reason: "not-found" });
			const { rt, run } = make({
				extra: [
					stub({
						remove: () => Effect.fail(failing),
						resolve: () => Effect.fail(failing),
					}),
				],
			});
			await run(Effect.flatMap(Credentials, (s) => s.remove("42")));
			expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("vault:9")))).toBeNull();
			expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("credential:9")))).toBeNull();
			await rt.dispose();
		}

		// credential:<numeric> ownership check: an owned id whose vault
		// resolve fails degrades to null; a failing ownership list
		// fails closed (empty).
		{
			const { rt, run } = make({
				extra: [
					stub({
						list: () => Effect.succeed([meta(9)]),
						resolve: () => Effect.fail(new SecretError({ reason: "not-found" })),
					}),
				],
			});
			expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("credential:9")))).toBeNull();
			await rt.dispose();
		}
		{
			const { rt, run } = make({
				extra: [stub({ list: () => Effect.fail(new SecretError({ reason: "invalid" })) })],
			});
			expect(await run(Effect.flatMap(Credentials, (s) => s.resolve("credential:9")))).toBeNull();
			await rt.dispose();
		}
	});
});
