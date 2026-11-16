import { describe, expect, it } from "vitest";

import { ApiKeys, type ApiKeyRow } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	EvalCredentials,
	EvalCredentialsLive,
	evalCredentialsChromePlugin,
	evalCredentialsPanelPlugin,
	evalCredentialsServicesPlugin,
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
					metadata: JSON.stringify(input.metadata),
				},
				referenceId: input.referenceId,
			});
			return { id };
		},
		list: async (referenceId: string) =>
			[...store.values()].filter((s) => s.referenceId === referenceId).map((s) => s.row),
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

const make = (opts: { allow?: boolean; seed?: readonly SeedRow[] } = {}) => {
	const { allow = true, seed = [] } = opts;
	const apiKeys = makeApiKeys(seed);
	const layers = Layer.mergeAll(apiKeys.layer, grantLayer(allow));
	const rt = ManagedRuntime.make(
		Layer.merge(EvalCredentialsLive.pipe(Layer.provide(layers)), layers),
	);
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

describe("EvalCredentials", () => {
	it("creates with provider+secret metadata, lists masked and removes", async () => {
		const { rt, run, apiKeys } = make();
		const { id } = await run(
			Effect.flatMap(EvalCredentials, (s) =>
				s.create({ name: "prod key", provider: "openai", secret: "sk-live-1234" }),
			),
		);
		expect(id).toBe("k1");
		expect(apiKeys.created[0]).toEqual({
			name: "prod key",
			referenceId: "u1",
			metadata: { kind: "credential", provider: "openai", secret: "sk-live-1234" },
		});

		const listed = await run(Effect.flatMap(EvalCredentials, (s) => s.list()));
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe("k1");
		expect(listed[0]?.name).toBe("prod key");
		expect(listed[0]?.provider).toBe("openai");
		expect(listed[0]?.masked).toBe("••••1234");

		await run(Effect.flatMap(EvalCredentials, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(EvalCredentials, (s) => s.list()))).toHaveLength(0);
		await rt.dispose();
	});

	it("scopes list/create to the principal's referenceId", async () => {
		const { rt, run } = make({
			seed: [
				{ row: row("other-1", '{"provider":"openai","secret":"sk-9999"}'), referenceId: "u2" },
			],
		});
		expect(await run(Effect.flatMap(EvalCredentials, (s) => s.list()))).toHaveLength(0);
		// No principal → empty referenceId.
		expect(
			await run(
				Effect.flatMap(EvalCredentials, (s) => s.list()),
				null,
			),
		).toHaveLength(0);
		await run(
			Effect.flatMap(EvalCredentials, (s) =>
				s.create({ name: "k", provider: "openai", secret: "s" }),
			),
			null,
		);
		expect(
			await run(
				Effect.flatMap(EvalCredentials, (s) => s.list()),
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
					row: row("c", '{"kind":"credential","provider":42,"secret":"sk-77777"}'),
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
		const listed = await run(Effect.flatMap(EvalCredentials, (s) => s.list()));
		const byId = new Map(listed.map((c) => [c.id, c] as const));
		expect(byId.get("a")?.masked).toBe("••••");
		expect(byId.get("b")?.masked).toBe("••••");
		expect(byId.get("b")?.name).toBe("credential");
		expect(byId.get("c")?.provider).toBe("other");
		expect(byId.get("c")?.masked).toBe("••••7777");
		// Rows without the kind marker are not eval credentials at all.
		expect(byId.has("d")).toBe(false);
		expect(byId.has("e")).toBe(false);
		expect(byId.has("f")).toBe(false);
		expect(byId.has("g")).toBe(false);
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
		const resolve = (ref: string) => run(Effect.flatMap(EvalCredentials, (s) => s.resolve(ref)));
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
			await run(Effect.flatMap(EvalCredentials, (s) => s.resolve("credential:other-1"))),
		).toBeNull();
		await run(Effect.flatMap(EvalCredentials, (s) => s.remove("other-1")));
		expect(apiKeys.store.has("other-1")).toBe(true);
		// ...while the owner can still resolve it.
		expect(
			await run(
				Effect.flatMap(EvalCredentials, (s) => s.resolve("credential:other-1")),
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
				Effect.flatMap(EvalCredentials, (s) => s.resolve("credential:orphan")),
				null,
			),
		).toBe("sk-1");
		await run(
			Effect.flatMap(EvalCredentials, (s) => s.remove("orphan")),
			null,
		);
		expect(apiKeys.store.has("orphan")).toBe(false);
		await rt.dispose();
	});

	it("denies everything without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(EvalCredentials, (s) => s.list()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(
				Effect.flatMap(EvalCredentials, (s) =>
					s.create({ name: "k", provider: "openai", secret: "s" }),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(run(Effect.flatMap(EvalCredentials, (s) => s.remove("k1")))).rejects.toMatchObject(
			{ _tag: "Forbidden" },
		);
		await expect(
			run(Effect.flatMap(EvalCredentials, (s) => s.resolve("credential:k1"))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await rt.dispose();
	});
});

describe("eval-credentials plugin manifests", () => {
	it("registers services, chrome and the panel page — no tables", () => {
		expect(evalCredentialsServicesPlugin.id).toBe("eval.credentials.services");
		expect(evalCredentialsServicesPlugin.requiredDeps).toEqual([]);
		expect((evalCredentialsServicesPlugin as { readonly tables?: unknown }).tables).toBeUndefined();
		expect(evalCredentialsChromePlugin.id).toBe("eval.credentials.chrome");
		expect(evalCredentialsChromePlugin.chrome?.[0]?.id).toBe("eval-credentials.sidebar");
		expect(evalCredentialsPanelPlugin.requiredDeps).toContain("eval.credentials.services");
		expect(plugins).toHaveLength(3);
	});

	it("panel guard reflects the grant and loader degrades to []", async () => {
		const page = evalCredentialsPanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("eval.credentials");
		expect(page?.path).toBe("/platform/eval/credentials");
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
			Effect.flatMap(EvalCredentials, (s) =>
				s.create({ name: "k", provider: "openai", secret: "s12345" }),
			),
		);
		const page = evalCredentialsPanelPlugin.panel!.pages![0]!;
		const data = await run(page.loader!() as Effect.Effect<readonly unknown[], never, unknown>);
		expect(data).toHaveLength(1);
		await rt.dispose();
	});
});

describe("client plugin mirror", () => {
	it("mirrors the client-safe plugin ids, sidebar item, and panel page", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"eval.credentials.services",
			"eval.credentials.chrome",
			"eval.credentials.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "eval.credentials.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["eval-credentials.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "eval.credentials.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/eval/credentials"]);
	});

	it("keeps the schema module table-free — credentials live in apikey", () => {
		expect(Object.keys(schemaModule)).toHaveLength(0);
	});
});
