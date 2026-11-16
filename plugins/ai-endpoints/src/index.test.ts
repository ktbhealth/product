import { describe, expect, it } from "vitest";

import { ApiKeys } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Credentials, CredentialsLive } from "@ktb/credentials";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	LlmFactory,
	LlmPort,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	AI_ENDPOINTS_TEST_DDL,
	AiEndpoints,
	AiEndpointsLive,
	aiEndpointsPanelPlugin,
	type EndpointInput,
} from "./index.ts";
import { plugins as clientPlugins } from "./client.ts";
import { aiEndpoint } from "./schema.ts";

const grantLayer = (allow: boolean) =>
	Layer.succeed(
		Permissions,
		Permissions.of({
			permissionsFor: () => Effect.succeed(new Map()),
			canFor: () => Effect.succeed(allow),
			can: () => Effect.succeed(allow),
			requirePermissionFor: () =>
				allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
			requirePermission: () =>
				allow
					? Effect.void
					: (Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }) as never),
			invalidate: () => Effect.void,
		} as never),
	);

type FactoryKind = "ok" | "fail" | "raw";

const factoryLayer = (
	kind: FactoryKind,
	captured?: LlmEndpointDescriptor[],
	presets?: readonly LlmEndpointPreset[],
) =>
	Layer.succeed(
		LlmFactory,
		LlmFactory.of({
			resolve: (descriptor: LlmEndpointDescriptor) => {
				captured?.push(descriptor);
				return kind === "ok"
					? Effect.succeed(
							Layer.succeed(
								LlmPort,
								LlmPort.of({
									generate: () => Effect.succeed({ text: "ok", record: {} as never }),
									correct: () =>
										Effect.fail({ _tag: "PortError", port: "l", message: "x" } as never),
								}),
							),
						)
					: Effect.fail({ _tag: "PortError", port: "l", message: "down" } as never);
			},
			test: (descriptor: LlmEndpointDescriptor) => {
				captured?.push(descriptor);
				return kind === "ok"
					? Effect.void
					: kind === "raw"
						? (Effect.fail("raw outage") as never)
						: (Effect.fail({ _tag: "PortError", port: "l", message: "down" }) as never);
			},
			...(presets !== undefined ? { presets } : {}),
		}),
	);

/** In-memory ApiKeys fake for CredentialsLive — metadata carries
 * `{provider, secret}`; ids are the better-auth string keys. */
const apiKeysLayer = () => {
	let n = 0;
	const rows = new Map<string, { name: string; metadata: Record<string, unknown> }>();
	return Layer.succeed(
		ApiKeys,
		ApiKeys.of({
			create: async (input) => {
				const id = `k${++n}`;
				rows.set(id, { name: input.name, metadata: input.metadata });
				return { id };
			},
			list: async () =>
				[...rows.entries()].map(([id, r]) => ({
					id,
					referenceId: "u1",
					name: r.name,
					start: null,
					enabled: true,
					metadata: JSON.stringify(r.metadata),
				})),
			remove: async (id) => {
				rows.delete(id);
			},
			getSecret: async (id) => {
				const s = rows.get(id)?.metadata.secret;
				return typeof s === "string" ? s : null;
			},
		}),
	);
};

const make = (
	opts: {
		allow?: boolean;
		factory?: FactoryKind | "none";
		credentials?: boolean;
		captured?: LlmEndpointDescriptor[];
		presets?: readonly LlmEndpointPreset[];
	} = {},
) => {
	const { allow = true, factory = "none", credentials = false, captured, presets } = opts;
	const d1 = makeD1(AI_ENDPOINTS_TEST_DDL);
	const db = makeDb(d1);
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as never),
		grantLayer(allow),
		apiKeysLayer(),
		factory === "none" ? Layer.empty : factoryLayer(factory, captured, presets),
	);
	const rt = ManagedRuntime.make(
		Layer.merge(
			Layer.mergeAll(
				AiEndpointsLive,
				// Soft dep: `credentials: true` binds the credential store so
				// `credential:<id>` refs resolve to raw keys.
				...(credentials ? [CredentialsLive] : []),
			).pipe(Layer.provide(layers)),
			layers,
		) as Layer.Layer<unknown, never, never>,
	);
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		rt.runPromise(
			Effect.provideService(effect, Principal, {
				userId: "u1",
				email: "v@x.com",
			} as never),
		);
	return { rt, run, db };
};

const EP: EndpointInput = {
	name: "Ollama",
	kind: "openai",
	baseUrl: "http://localhost:11434/v1",
	model: "qwen2.5:7b",
	timeoutMs: 5_000,
};

describe("AiEndpoints", () => {
	it("cruds endpoints and tests through the factory", async () => {
		const { rt, run } = make({ factory: "ok" });
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const listed = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(listed[0]?.kind).toBe("openai");
		expect(listed[0]?.model).toBe("qwen2.5:7b");
		expect(listed[0]?.scope).toBe("eval");
		expect(listed[0]?.isDefault).toBe(false);

		const got = await run(Effect.flatMap(AiEndpoints, (s) => s.get(id)));
		expect(got?.name).toBe("Ollama");
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.get(999)))).toBeNull();

		await run(
			Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id, name: "Ollama 2", enabled: false })),
		);
		const updated = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(updated[0]?.enabled).toBe(false);
		expect(updated[0]?.name).toBe("Ollama 2");

		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.remove(id)));
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.list()))).toHaveLength(0);
		await rt.dispose();
	});

	it("filters list by scope", async () => {
		const { rt, run } = make();
		await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, name: "ops", scope: "ops" })));
		const all = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(all).toHaveLength(2);
		const evalOnly = await run(Effect.flatMap(AiEndpoints, (s) => s.list("eval")));
		expect(evalOnly.map((e) => e.name)).toEqual(["Ollama"]);
		const ops = await run(Effect.flatMap(AiEndpoints, (s) => s.list("ops")));
		expect(ops.map((e) => e.name)).toEqual(["ops"]);
		await rt.dispose();
	});

	it("test fails without a factory bound", async () => {
		const { rt, run } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.test(id)))).rejects.toMatchObject({
			_tag: "PortError",
		});
		await rt.dispose();
	});

	it("test is a no-op for unknown ids", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(999)));
		expect(captured).toHaveLength(0);
		await rt.dispose();
	});

	it("presets mirror the bound factory's provider list", async () => {
		const adapterPresets: readonly LlmEndpointPreset[] = [
			{ label: "OpenAI", kind: "openai", baseUrl: "https://hosted.example/v1", model: "m" },
		];
		const { rt, run } = make({ factory: "ok", presets: adapterPresets });
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.presets()))).toEqual(adapterPresets);
		await rt.dispose();

		// Factory without presets → []; no factory → [].
		const bare = make({ factory: "ok" });
		expect(await bare.run(Effect.flatMap(AiEndpoints, (s) => s.presets()))).toEqual([]);
		await bare.rt.dispose();
		const none = make();
		expect(await none.run(Effect.flatMap(AiEndpoints, (s) => s.presets()))).toEqual([]);
		await none.rt.dispose();
	});

	it("denies everything without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.list()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.get(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			run(Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id: 1 }))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.remove(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.presets()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.test(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.resolve(1)))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault()))).rejects.toMatchObject(
			{ _tag: "Forbidden" },
		);
		await rt.dispose();
	});
});

describe("AiEndpoints.resolve", () => {
	it("returns null for unknown and disabled endpoints", async () => {
		const { rt, run } = make();
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.resolve(999)))).toBeNull();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id, enabled: false })));
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.resolve(id)))).toBeNull();
		await rt.dispose();
	});

	it("builds descriptors for both kinds and keeps env refs as names", async () => {
		const { rt, run } = make();
		const { id: openai } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ ...EP, sessionId: "sess-1", secretRef: "MY_KEY" }),
			),
		);
		const d = await run(Effect.flatMap(AiEndpoints, (s) => s.resolve(openai)));
		expect(d).toMatchObject({
			kind: "openai",
			baseUrl: EP.baseUrl,
			model: EP.model,
			sessionId: "sess-1",
			secretRef: "MY_KEY",
			timeoutMs: 5_000,
		});
		expect(d?.transport).toBeUndefined();
		expect(d?.apiKey).toBeUndefined();

		const { id: acp } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ name: "acp", kind: "acp", baseUrl: "ws://h", transport: "child" }),
			),
		);
		const d2 = await run(Effect.flatMap(AiEndpoints, (s) => s.resolve(acp)));
		expect(d2).toMatchObject({ kind: "acp", baseUrl: "ws://h", transport: "child" });
		expect(d2 && "model" in d2).toBe(false);
		await rt.dispose();
	});

	it("resolves credential:<id> refs into apiKey through the credentials store", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", credentials: true, captured });
		const { id: credId } = await run(
			Effect.flatMap(Credentials, (c) =>
				c.create({ name: "prod key", provider: "openai", secret: "sk-live-9" }),
			),
		);
		const { id: epId } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, secretRef: `credential:${credId}` })),
		);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(epId)));
		expect(captured.at(-1)?.apiKey).toBe("sk-live-9");
		expect(captured.at(-1)?.secretRef).toBeUndefined();
		await rt.dispose();
	});

	it("drops credential refs when the store or the credential is absent", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		// No CredentialsLive — the credential:<id> ref can't resolve.
		const bare = make({ factory: "ok", captured });
		const { id: epId } = await bare.run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, secretRef: "credential:k9" })),
		);
		await bare.run(Effect.flatMap(AiEndpoints, (s) => s.test(epId)));
		expect(captured.at(-1)?.apiKey).toBeUndefined();
		expect(captured.at(-1)?.secretRef).toBeUndefined();
		await bare.rt.dispose();

		// Store bound but the credential row is gone.
		const missing = make({ factory: "ok", credentials: true, captured });
		const { id: ep2 } = await missing.run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, secretRef: "credential:gone" })),
		);
		await missing.run(Effect.flatMap(AiEndpoints, (s) => s.test(ep2)));
		expect(captured.at(-1)?.apiKey).toBeUndefined();
		await missing.rt.dispose();
	});
});

describe("endpoint transport", () => {
	it("stores transport on save and forwards it to the descriptor", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		const { id: ssh } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ name: "acp-ssh", kind: "acp", baseUrl: "ssh://h", transport: "ssh" }),
			),
		);
		const listed = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(listed[0]?.transport).toBe("ssh");
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(ssh)));
		expect(captured.at(-1)?.transport).toBe("ssh");

		const { id: ws } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ name: "acp-ws", kind: "acp", baseUrl: "ws://h", transport: "ws" }),
			),
		);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(ws)));
		expect(captured.at(-1)?.transport).toBe("ws");
		await rt.dispose();
	});

	it("omits transport on the descriptor for null or unrecognized values", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run, db } = make({ factory: "ok", captured });
		const { id: bare } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ name: "acp-bare", kind: "acp", baseUrl: "ws://h" }),
			),
		);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(bare)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		// Bogus value written straight to the row — the descriptor
		// whitelist drops anything outside ws|child|ssh.
		await db.update(aiEndpoint).set({ transport: "carrier-pigeon" }).where(eq(aiEndpoint.id, bare));
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(bare)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		// Transport is acp-only — an openai row never forwards it even
		// when a value is stored.
		const { id: openai } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ name: "o", kind: "openai", baseUrl: "https://h/v1" }),
			),
		);
		await db.update(aiEndpoint).set({ transport: "ws" }).where(eq(aiEndpoint.id, openai));
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(openai)));
		expect(captured.at(-1)?.transport).toBeUndefined();
		await rt.dispose();
	});
});

describe("AiEndpoints.resolveDefault", () => {
	it("returns null with no enabled endpoints", async () => {
		const { rt, run } = make();
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault()))).toBeNull();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.update({ ...EP, id, enabled: false })));
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault()))).toBeNull();
		await rt.dispose();
	});

	it("prefers the flagged default, then the newest enabled, scoped or not", async () => {
		const { rt, run } = make();
		const { id: older } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const { id: newer } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, name: "newer", isDefault: true })),
		);
		// is_default wins over recency.
		const d = await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault()));
		expect(d?.baseUrl).toBe(EP.baseUrl);
		const rows = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(rows.find((r) => r.id === newer)?.isDefault).toBe(true);

		// Unflag the default — the newest enabled row wins.
		await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.update({ ...EP, id: newer, name: "newer", isDefault: false }),
			),
		);
		const d2 = await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault()));
		expect(d2).not.toBeNull();
		const ops = await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault("ops")));
		expect(ops).toBeNull();
		// Scoped: only ops-scope rows qualify.
		await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ ...EP, name: "ops-ep", scope: "ops", baseUrl: "http://ops/v1" }),
			),
		);
		const ops2 = await run(Effect.flatMap(AiEndpoints, (s) => s.resolveDefault("ops")));
		expect(ops2?.baseUrl).toBe("http://ops/v1");
		void older;
		await rt.dispose();
	});
});

describe("aiEndpointsPanelPlugin", () => {
	it("declares the AI endpoints page with a grant-gated loader", () => {
		const page = aiEndpointsPanelPlugin.panel?.pages[0];
		expect(page?.id).toBe("ai.endpoints");
		expect(page?.path).toBe("/platform/ai/endpoints");
		expect(page?.component).toBeDefined();
		expect(page?.guard).toBeDefined();
		expect(page?.loader).toBeDefined();
	});

	it("guard mirrors the grant, loader lists endpoints and degrades to []", async () => {
		const page = aiEndpointsPanelPlugin.panel?.pages[0];
		const allowed = make({ allow: true });
		await allowed.run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		expect(await allowed.run(page!.guard!() as Effect.Effect<boolean>)).toBe(true);
		const rows = await allowed.run(
			page!.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		);
		expect(rows).toHaveLength(1);

		const denied = make({ allow: false });
		expect(await denied.run(page!.guard!() as Effect.Effect<boolean>)).toBe(false);
		const empty = await denied.run(
			page!.loader!() as Effect.Effect<readonly unknown[], never, unknown>,
		);
		expect(empty).toEqual([]);
		await allowed.rt.dispose();
		await denied.rt.dispose();
	});
});

describe("client plugin mirror", () => {
	it("mirrors the client-safe plugin ids, sidebar item, and panel page", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"ai.endpoints.tables",
			"ai.endpoints.services",
			"ai.endpoints.chrome",
			"ai.endpoints.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "ai.endpoints.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["ai-endpoints.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "ai.endpoints.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/endpoints"]);
	});
});
