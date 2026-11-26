import { describe, expect, it } from "vitest";

import { ApiKeys } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Credentials, CredentialsLive } from "@ktb/credentials";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	DecisionsFactory,
	DecisionsPort,
	LlmFactory,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";
import { Machines, type MachineCard } from "@ktb/machines";
import { Permissions } from "@ktb/rbac";
import { Secrets } from "@ktb/vault";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	agentLinkStatus,
	AI_ENDPOINTS_TEST_DDL,
	AiEndpoints,
	AiEndpointsLive,
	aiEndpointsPanelPlugin,
	isBridgeEndpoint,
	PlatformDecisionsLive,
	PlatformLlmLive,
	type EndpointInput,
} from "./index.ts";
import { sha256Hex } from "./bridge-token.ts";
import { plugins as clientPlugins } from "./client.ts";
import { aiAgentLink, aiEndpoint } from "./schema.ts";

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

const decisionsFactoryLayer = (
	kind: FactoryKind,
	captured?: LlmEndpointDescriptor[],
	presets?: readonly LlmEndpointPreset[],
) =>
	Layer.succeed(
		DecisionsFactory,
		DecisionsFactory.of({
			resolve: (descriptor: LlmEndpointDescriptor) => {
				captured?.push(descriptor);
				return kind === "ok"
					? Effect.succeed(
							Layer.succeed(
								DecisionsPort,
								DecisionsPort.of({
									judge: () => Effect.succeed({ answers: [], record: {} as never }),
								}),
							),
						)
					: Effect.fail({ _tag: "PortError", port: "d", message: "down" } as never);
			},
			test: (descriptor: LlmEndpointDescriptor) => {
				captured?.push(descriptor);
				return kind === "ok"
					? Effect.void
					: kind === "raw"
						? (Effect.fail("raw outage") as never)
						: (Effect.fail({ _tag: "PortError", port: "d", message: "down" }) as never);
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

const MACHINE_CARD: MachineCard = {
	id: 7,
	scope: "platform",
	tenantId: null,
	name: "gpu-box",
	kind: "vm",
	host: "gpu.internal:2222",
	port: null,
	capabilities: [],
	secretRef: "vault:42",
	healthUrl: null,
	status: "online",
	lastSeenAt: null,
	lastCheckAt: null,
	checkError: null,
	enabled: true,
	createdAt: new Date(0),
	updatedAt: null,
};

/** Machines service stub — only `resolve` is exercised by descriptor
 * resolution; the rest of the surface is irrelevant here. */
const machinesLayer = (card: MachineCard | null | "fail") =>
	Layer.succeed(Machines, {
		resolve: () =>
			card === "fail" ? Effect.fail(new Error("machines down")) : Effect.succeed(card),
	} as never);

const make = (
	opts: {
		allow?: boolean;
		factory?: FactoryKind | "none";
		credentials?: boolean;
		machines?: MachineCard | null | "fail";
		captured?: LlmEndpointDescriptor[];
		presets?: readonly LlmEndpointPreset[];
		/** Decision-factory stub — `"none"` (default) leaves
		 * DecisionsFactory unbound like a deployment without the
		 * systemone adapter driver. */
		decisionsFactory?: FactoryKind | "none";
		/** Capture array for the DecisionsFactory stub — defaults to
		 * `captured` so single-factory tests stay terse. */
		decisionsCaptured?: LlmEndpointDescriptor[];
		/** Presets declared by the DecisionsFactory stub (defaults to
		 * `presets` when unset — most tests bind only one factory). */
		decisionsPresets?: readonly LlmEndpointPreset[];
		/** Vault `Secrets` stub — only `resolve` is exercised. */
		secrets?: (ref: string) => Effect.Effect<string | null, unknown>;
	} = {},
) => {
	const {
		allow = true,
		factory = "none",
		credentials = false,
		machines,
		captured,
		presets,
		decisionsFactory = "none",
		decisionsCaptured,
		decisionsPresets,
		secrets,
	} = opts;
	const d1 = makeD1(AI_ENDPOINTS_TEST_DDL);
	const db = makeDb(d1);
	const layers = Layer.mergeAll(
		Layer.succeed(Db, db as never),
		grantLayer(allow),
		apiKeysLayer(),
		factory === "none" ? Layer.empty : factoryLayer(factory, captured, presets),
		decisionsFactory === "none"
			? Layer.empty
			: decisionsFactoryLayer(
					decisionsFactory,
					decisionsCaptured ?? captured,
					decisionsPresets ?? presets,
				),
		...(machines !== undefined ? [machinesLayer(machines)] : []),
		...(secrets !== undefined
			? [Layer.succeed(Secrets, { resolve: secrets } as never) as Layer.Layer<unknown>]
			: []),
	);
	const rt = ManagedRuntime.make(
		Layer.merge(
			Layer.mergeAll(
				AiEndpointsLive,
				PlatformLlmLive,
				PlatformDecisionsLive,
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
		await expect(
			run(Effect.flatMap(AiEndpoints, (s) => s.setPlatformDefault(1))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
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

	it("resolves vault:<id> refs into apiKey through the secrets store", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({
			factory: "ok",
			captured,
			secrets: (ref) =>
				ref === "vault:42" ? Effect.succeed("sk-vault") : Effect.fail(new Error("secret gone")),
		});
		const { id: ok } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, secretRef: "vault:42" })),
		);
		const { id: bad } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...EP, name: "O2", secretRef: "vault:99" })),
		);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(ok)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(bad)));
		// Resolved ref becomes apiKey; a failing resolve drops the key.
		expect(captured.at(-2)?.apiKey).toBe("sk-vault");
		expect(captured.at(-1)?.apiKey).toBeUndefined();
		expect(captured.at(-1)?.secretRef).toBeUndefined();
		await rt.dispose();
	});
});

describe("endpoint transport", () => {
	it("stores transport on save and forwards it to the descriptor", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		const { id: ssh } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({
					name: "acp-ssh",
					kind: "acp",
					baseUrl: "ssh://h",
					transport: "ssh",
					agentCmd: "claude-agent-acp",
					sshHost: "me@gpu-box",
				}),
			),
		);
		const listed = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(listed[0]?.transport).toBe("ssh");
		expect(listed[0]?.agentCmd).toBe("claude-agent-acp");
		expect(listed[0]?.sshHost).toBe("me@gpu-box");
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(ssh)));
		expect(captured.at(-1)?.transport).toBe("ssh");
		expect(captured.at(-1)).toMatchObject({
			agentCmd: "claude-agent-acp",
			sshHost: "me@gpu-box",
		});

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

describe("machine-linked endpoints (D3)", () => {
	const ACP_SSH: EndpointInput = {
		name: "acp-on-gpu",
		kind: "acp",
		baseUrl: "ssh://gpu",
		transport: "ssh",
		agentCmd: "claude-agent-acp",
		machineId: 7,
	};

	it("fills sshHost from the machine card and persists machineId", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured, machines: MACHINE_CARD });
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(ACP_SSH)));
		const listed = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(listed[0]?.machineId).toBe(7);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		expect(captured.at(-1)).toMatchObject({
			transport: "ssh",
			agentCmd: "claude-agent-acp",
			sshHost: "gpu.internal:2222",
		});
		await rt.dispose();
	});

	it("explicit sshHost wins over the machine card", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured, machines: MACHINE_CARD });
		const { id } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...ACP_SSH, sshHost: "me@override" })),
		);
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		expect(captured.at(-1)?.sshHost).toBe("me@override");
		await rt.dispose();
	});

	it("degrades to endpoint fields when the machine is missing or the plugin is absent", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		// Machines bound but resolve() → null (deleted/disabled row).
		const missing = make({ factory: "ok", captured, machines: null });
		const { id: a } = await missing.run(Effect.flatMap(AiEndpoints, (s) => s.create(ACP_SSH)));
		await missing.run(Effect.flatMap(AiEndpoints, (s) => s.test(a)));
		expect(captured.at(-1)?.sshHost).toBeUndefined();
		await missing.rt.dispose();
		// No Machines service bound at all — serviceOption → None.
		const absent = make({ factory: "ok", captured });
		const { id: b } = await absent.run(Effect.flatMap(AiEndpoints, (s) => s.create(ACP_SSH)));
		await absent.run(Effect.flatMap(AiEndpoints, (s) => s.test(b)));
		expect(captured.at(-1)?.sshHost).toBeUndefined();
		await absent.rt.dispose();
	});

	it("degrades when machines.resolve itself fails", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured, machines: "fail" });
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(ACP_SSH)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		expect(captured.at(-1)?.sshHost).toBeUndefined();
		await rt.dispose();
	});
});

describe("bridge endpoints (F3b)", () => {
	const BRIDGE_EP: EndpointInput = {
		name: "Local agent",
		kind: "acp",
		baseUrl: "",
		transport: "ws",
	};

	it("persists base_url NULL for bridge endpoints and resolves endpointId descriptors", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run, db } = make({ factory: "ok", captured });
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));
		const card = await run(Effect.flatMap(AiEndpoints, (s) => s.get(id)));
		// The DTO keeps "" as the sentinel; the row stores NULL.
		expect(card?.baseUrl).toBe("");
		expect(card?.lastSeenAt).toBeNull();
		const row = (await db.select().from(aiEndpoint))[0]!;
		expect(row.baseUrl).toBeNull();
		expect(isBridgeEndpoint(row)).toBe(true);
		expect(isBridgeEndpoint({ kind: "openai", baseUrl: null, transport: null })).toBe(false);
		// transport null defaults to ws — the bridge shape.
		expect(isBridgeEndpoint({ kind: "acp", baseUrl: null, transport: null })).toBe(true);
		expect(isBridgeEndpoint({ kind: "acp", baseUrl: "ws://h", transport: "ws" })).toBe(false);
		expect(isBridgeEndpoint({ kind: "acp", baseUrl: null, transport: "child" })).toBe(false);
		// The descriptor carries "" + endpointId — the factory routes it
		// through the ACP_BRIDGE DO binding.
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		expect(captured.at(-1)).toMatchObject({
			kind: "acp",
			baseUrl: "",
			transport: "ws",
			endpointId: id,
		});
		await rt.dispose();
	});

	it("createBridgeLink mints a link storing only the SHA-256", async () => {
		const { rt, run, db } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));
		const link = await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1")));
		expect(link).not.toBeNull();
		expect(link!.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(link!.expiresAt.getTime()).toBeGreaterThan(Date.now());
		const rows = await db.select().from(aiAgentLink);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.endpointId).toBe(id);
		expect(rows[0]!.createdBy).toBe("u1");
		expect(rows[0]!.usedAt).toBeNull();
		// Only the hash touches the table — the raw token is never stored.
		expect(rows[0]!.tokenHash).toBe(await sha256Hex(link!.token));
		expect(rows[0]!.tokenHash).not.toContain(link!.token);
		await rt.dispose();
	});

	it("createBridgeLink refuses non-bridge, disabled, unknown endpoints and missing grants", async () => {
		const { rt, run } = make();
		const { id: openai } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const { id: acpUrl } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ ...BRIDGE_EP, name: "remote", baseUrl: "ws://h" }),
			),
		);
		const { id: acpChild } = await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.create({ ...BRIDGE_EP, name: "child", transport: "child", agentCmd: "cat" }),
			),
		);
		const { id: disabled } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...BRIDGE_EP, name: "off", enabled: false })),
		);
		for (const id of [openai, acpUrl, acpChild, disabled, 9999]) {
			expect(
				await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1"))),
			).toBeNull();
		}
		await rt.dispose();

		const denied = make({ allow: false });
		await expect(
			denied.run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(1, "u1"))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await denied.rt.dispose();
	});

	it("bridgeStatus reports offline → waiting → connected from links and last_seen_at", async () => {
		const { rt, run, db } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));

		// Fresh endpoint: never seen, no open link.
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id)))).toMatchObject({
			status: "offline",
			lastSeenAt: null,
		});

		// A minted-but-unconsumed link means somebody is about to connect.
		await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1")));
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id))))?.status).toBe(
			"waiting",
		);

		// A live socket inside the heartbeat window beats the link check.
		await db.update(aiEndpoint).set({ lastSeenAt: new Date() }).where(eq(aiEndpoint.id, id));
		const connected = await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id)));
		expect(connected?.status).toBe("connected");
		expect(connected?.lastSeenAt).not.toBeNull();

		// Stale liveness falls back to the open link.
		await db
			.update(aiEndpoint)
			.set({ lastSeenAt: new Date(Date.now() - 120_000) })
			.where(eq(aiEndpoint.id, id));
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id))))?.status).toBe(
			"waiting",
		);

		// Consume the link → back to offline.
		await db.update(aiAgentLink).set({ usedAt: new Date() }).where(eq(aiAgentLink.endpointId, id));
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id))))?.status).toBe(
			"offline",
		);

		// An expired link never counts as waiting.
		await db.insert(aiAgentLink).values({
			endpointId: id,
			tokenHash: "deadbeef",
			createdBy: "u1",
			expiresAt: new Date(Date.now() - 1_000),
			createdAt: new Date(),
		});
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id))))?.status).toBe(
			"offline",
		);
		await rt.dispose();
	});

	it("bridgeStatus answers null for non-bridge, disabled, and unknown endpoints", async () => {
		const { rt, run } = make();
		const { id: openai } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		const { id: disabled } = await run(
			Effect.flatMap(AiEndpoints, (s) => s.create({ ...BRIDGE_EP, enabled: false })),
		);
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(openai)))).toBeNull();
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(disabled)))).toBeNull();
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(9999)))).toBeNull();
		await rt.dispose();
	});
});

describe("agent links (F4)", () => {
	const BRIDGE_EP: EndpointInput = {
		name: "Local agent",
		kind: "acp",
		baseUrl: "",
		transport: "ws",
	};

	it("agentLinkStatus derives all five states", () => {
		const now = Date.now();
		const fresh = { usedAt: null, expiresAt: new Date(now + 60_000), revokedAt: null };
		expect(agentLinkStatus(fresh, null, now)).toBe("waiting");
		expect(agentLinkStatus({ ...fresh, expiresAt: new Date(now - 1) }, null, now)).toBe("expired");
		expect(
			agentLinkStatus({ ...fresh, usedAt: new Date(now - 5_000) }, new Date(now - 30_000), now),
		).toBe("connected");
		expect(
			agentLinkStatus({ ...fresh, usedAt: new Date(now - 5_000) }, new Date(now - 120_000), now),
		).toBe("offline");
		// Used but never heartbeat-stamped reads offline.
		expect(agentLinkStatus({ ...fresh, usedAt: new Date() }, null, now)).toBe("offline");
		// Revoked beats every other state.
		expect(agentLinkStatus({ ...fresh, revokedAt: new Date() }, null, now)).toBe("revoked");
		expect(
			agentLinkStatus({ ...fresh, usedAt: new Date(), revokedAt: new Date() }, new Date(), now),
		).toBe("revoked");
	});

	it("listAgentLinks joins endpoint names and never emits the token hash", async () => {
		const { rt, run } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));
		const minted = await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1")));
		expect(minted).not.toBeNull();
		const links = await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks()));
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			endpointId: id,
			endpointName: "Local agent",
			status: "waiting",
			usedAt: null,
			lastSeenAt: null,
		});
		expect(links[0]?.createdAt).toBeInstanceOf(Date);
		expect(links[0]?.expiresAt).toBeInstanceOf(Date);
		// The wire shape carries no token material at all.
		expect(links[0]).not.toHaveProperty("token");
		expect(links[0]).not.toHaveProperty("tokenHash");
		expect(JSON.stringify(links[0])).not.toContain(minted!.token);
		await rt.dispose();
	});

	it("listAgentLinks reflects connected/expired/revoked states", async () => {
		const { rt, run, db } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1")));
		// consumed + live heartbeat → connected
		const seen = new Date();
		await db.update(aiAgentLink).set({ usedAt: seen }).where(eq(aiAgentLink.endpointId, id));
		await db.update(aiEndpoint).set({ lastSeenAt: seen }).where(eq(aiEndpoint.id, id));
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks())))[0]?.status).toBe(
			"connected",
		);
		// stale heartbeat → offline
		await db
			.update(aiEndpoint)
			.set({ lastSeenAt: new Date(Date.now() - 120_000) })
			.where(eq(aiEndpoint.id, id));
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks())))[0]?.status).toBe(
			"offline",
		);
		// expired unused link → expired
		await db.insert(aiAgentLink).values({
			endpointId: id,
			tokenHash: "expired-hash",
			createdBy: "u1",
			expiresAt: new Date(Date.now() - 1_000),
			createdAt: new Date(),
		});
		const links = await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks()));
		expect(links).toHaveLength(2);
		expect(links.map((l) => l.status).sort()).toEqual(["expired", "offline"]);
		await rt.dispose();
	});

	it("revokeAgentLink stamps revoked_at once and drops the link from bridgeStatus", async () => {
		const { rt, run, db } = make();
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(BRIDGE_EP)));
		await run(Effect.flatMap(AiEndpoints, (s) => s.createBridgeLink(id, "u1")));
		const [link] = await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks()));
		expect(link?.status).toBe("waiting");

		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.revokeAgentLink(link!.id)))).toBe(true);
		const row = (await db.select().from(aiAgentLink))[0]!;
		expect(row.revokedAt).toBeInstanceOf(Date);
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks())))[0]?.status).toBe(
			"revoked",
		);
		// A revoked link no longer counts as an open link for the badge.
		expect((await run(Effect.flatMap(AiEndpoints, (s) => s.bridgeStatus(id))))?.status).toBe(
			"offline",
		);
		// Idempotent-ish: unknown and already-revoked ids answer false.
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.revokeAgentLink(link!.id)))).toBe(false);
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.revokeAgentLink(9999)))).toBe(false);
		await rt.dispose();
	});

	it("denies link listing and revocation without the grant", async () => {
		const { rt, run } = make({ allow: false });
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.listAgentLinks()))).rejects.toMatchObject(
			{ _tag: "Forbidden" },
		);
		await expect(
			run(Effect.flatMap(AiEndpoints, (s) => s.revokeAgentLink(1))),
		).rejects.toMatchObject({ _tag: "Forbidden" });
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
		expect(page?.id).toBe("ai.provider");
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

	it("declares the Agents page (F4) under the same grant with a combined loader", async () => {
		const page = aiEndpointsPanelPlugin.panel?.pages[1];
		expect(page?.id).toBe("ai.agents");
		expect(page?.path).toBe("/platform/ai/agents");
		expect(page?.component).toBeDefined();

		const allowed = make({ allow: true });
		await allowed.run(Effect.flatMap(AiEndpoints, (s) => s.create(EP)));
		expect(await allowed.run(page!.guard!() as Effect.Effect<boolean>)).toBe(true);
		const data = (await allowed.run(page!.loader!() as Effect.Effect<unknown, never, unknown>)) as {
			links: readonly unknown[];
			endpoints: readonly unknown[];
		};
		expect(data.links).toEqual([]);
		expect(data.endpoints).toHaveLength(1);

		const denied = make({ allow: false });
		expect(await denied.run(page!.guard!() as Effect.Effect<boolean>)).toBe(false);
		const empty = (await denied.run(page!.loader!() as Effect.Effect<unknown, never, unknown>)) as {
			links: readonly unknown[];
			endpoints: readonly unknown[];
		};
		expect(empty).toEqual({ links: [], endpoints: [] });
		await allowed.rt.dispose();
		await denied.rt.dispose();
	});
});

describe("client plugin mirror", () => {
	it("mirrors the client-safe plugin ids, sidebar item, and panel page", () => {
		expect(clientPlugins.map((p) => p.id)).toEqual([
			"ai.provider.tables",
			"ai.provider.services",
			"ai-provider.routes",
			"ai.provider.chrome",
			"ai.provider.panel",
		]);
		const chrome = clientPlugins.find((p) => p.id === "ai.provider.chrome")?.chrome ?? [];
		expect(chrome.map((c) => c.id)).toEqual(["ai-provider.sidebar", "ai-agents.sidebar"]);
		const pages = clientPlugins.find((p) => p.id === "ai.provider.panel")?.panel?.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/platform/ai/endpoints", "/platform/ai/agents"]);
	});
});

describe("PlatformLlm", () => {
	const seed = async (
		run: <A, E>(e: Effect.Effect<A, E, unknown>) => Promise<A>,
		...inputs: readonly EndpointInput[]
	) => {
		const ids: number[] = [];
		for (const input of inputs) {
			const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(input)));
			ids.push(id);
		}
		return ids;
	};

	it("resolves the enabled platform default into an LlmPort layer", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		await seed(run, { ...EP, scope: "platform", isDefault: true });
		const layer = await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()));
		expect(layer).not.toBeNull();
		// The resolved layer actually binds a working port.
		const out = await run(
			Effect.flatMap(LlmPort, (llm) =>
				llm.generate({ taskId: "t", role: "generator", input: "x", outputSchema: "Text" }),
			).pipe(Effect.provide(layer!)),
		);
		expect(out.text).toBe("ok");
		expect(captured[0]).toMatchObject({ kind: "openai", baseUrl: EP.baseUrl });
		await rt.dispose();
	});

	it("answers null when no platform default exists — the env fallback path", async () => {
		const { rt, run } = make({ factory: "ok" });
		await seed(
			run,
			{ ...EP, name: "eval default", isDefault: true }, // eval scope ≠ platform
			{ ...EP, name: "platform but not default", scope: "platform" },
		);
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();
		await rt.dispose();
	});

	it("answers null without a factory bound", async () => {
		const { rt, run } = make();
		await seed(run, { ...EP, scope: "platform", isDefault: true });
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();
		await rt.dispose();
	});

	it("degrades to null when the factory rejects the descriptor", async () => {
		const { rt, run } = make({ factory: "fail" });
		await seed(run, { ...EP, scope: "platform", isDefault: true });
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();
		await rt.dispose();
	});

	it("skips disabled defaults and setPlatformDefault swaps atomically", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ factory: "ok", captured });
		const [first, second] = await seed(
			run,
			{ ...EP, name: "first", scope: "platform", isDefault: true },
			{ ...EP, name: "second" },
		);
		// Disabling the default skips it entirely.
		await run(
			Effect.flatMap(AiEndpoints, (s) =>
				s.update({
					...EP,
					id: first,
					name: "first",
					scope: "platform",
					isDefault: true,
					enabled: false,
				}),
			),
		);
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();

		// Promoting the second endpoint flips scope + is_default in one
		// batch — the disabled row keeps its stale flag cleared by the
		// swap's WHERE clause? No: the swap clears platform defaults
		// THEN flags the target, so exactly one platform default exists.
		await run(Effect.flatMap(AiEndpoints, (s) => s.setPlatformDefault(second)));
		const rows = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		const promoted = rows.find((r) => r.id === second);
		expect(promoted?.scope).toBe("platform");
		expect(promoted?.isDefault).toBe(true);
		expect(rows.filter((r) => r.scope === "platform" && r.isDefault)).toHaveLength(1);
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).not.toBeNull();
		expect(captured[0]?.baseUrl).toBe(EP.baseUrl);

		// Re-promoting the first row (still disabled) clears the second —
		// resolution then skips it for being disabled.
		await run(Effect.flatMap(AiEndpoints, (s) => s.setPlatformDefault(first)));
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();
		const after = await run(Effect.flatMap(AiEndpoints, (s) => s.list()));
		expect(after.filter((r) => r.scope === "platform" && r.isDefault).map((r) => r.id)).toEqual([
			first,
		]);
		await rt.dispose();
	});
});

describe("systemone endpoints", () => {
	const SYS_EP: EndpointInput = {
		name: "OpenJev",
		kind: "systemone",
		baseUrl: "http://127.0.0.1:8009",
		model: "wev-latest",
		timeoutMs: 5_000,
	};

	it("resolves kind=systemone descriptors and tests through DecisionsFactory", async () => {
		const llmCaptured: LlmEndpointDescriptor[] = [];
		const decisionsCaptured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({
			factory: "ok",
			decisionsFactory: "ok",
			captured: llmCaptured,
			decisionsCaptured,
		});
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(SYS_EP)));
		const d = await run(Effect.flatMap(AiEndpoints, (s) => s.resolve(id)));
		expect(d).toMatchObject({
			kind: "systemone",
			baseUrl: SYS_EP.baseUrl,
			model: "wev-latest",
			timeoutMs: 5_000,
			endpointId: id,
		});
		expect(d?.transport).toBeUndefined();
		// test() routes systemone rows to DecisionsFactory — the LLM
		// factory never sees the descriptor.
		const llmBefore = llmCaptured.length;
		const decisionsBefore = decisionsCaptured.length;
		await run(Effect.flatMap(AiEndpoints, (s) => s.test(id)));
		expect(llmCaptured).toHaveLength(llmBefore);
		expect(decisionsCaptured).toHaveLength(decisionsBefore + 1);
		expect(decisionsCaptured.at(-1)).toMatchObject({ kind: "systemone", endpointId: id });
		await rt.dispose();
	});

	it("test fails typed without a DecisionsFactory bound", async () => {
		const { rt, run } = make({ factory: "ok" });
		const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(SYS_EP)));
		await expect(run(Effect.flatMap(AiEndpoints, (s) => s.test(id)))).rejects.toMatchObject({
			_tag: "PortError",
			message: expect.stringContaining("DecisionsFactory"),
		});
		await rt.dispose();
	});

	it("presets merge generative and decision factory lists", async () => {
		const llmPreset: LlmEndpointPreset = {
			label: "OpenAI",
			kind: "openai",
			baseUrl: "https://hosted.example/v1",
		};
		const decisionsPreset: LlmEndpointPreset = {
			label: "System One",
			kind: "systemone",
			baseUrl: "http://127.0.0.1:8009",
		};
		const { rt, run } = make({
			factory: "ok",
			presets: [llmPreset],
			decisionsFactory: "ok",
			decisionsPresets: [decisionsPreset],
		});
		expect(await run(Effect.flatMap(AiEndpoints, (s) => s.presets()))).toEqual([
			llmPreset,
			decisionsPreset,
		]);
		await rt.dispose();
	});
});

describe("PlatformDecisions", () => {
	const seed = async (
		run: <A, E>(e: Effect.Effect<A, E, unknown>) => Promise<A>,
		...inputs: readonly EndpointInput[]
	) => {
		const ids: number[] = [];
		for (const input of inputs) {
			const { id } = await run(Effect.flatMap(AiEndpoints, (s) => s.create(input)));
			ids.push(id);
		}
		return ids;
	};

	it("resolves the enabled platform-default systemone endpoint into a DecisionsPort layer", async () => {
		const captured: LlmEndpointDescriptor[] = [];
		const { rt, run } = make({ decisionsFactory: "ok", captured });
		await seed(run, {
			name: "judge",
			kind: "systemone",
			baseUrl: "http://127.0.0.1:8009",
			scope: "platform",
			isDefault: true,
		});
		const layer = await run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer()));
		expect(layer).not.toBeNull();
		const out = await run(
			DecisionsPort.pipe(
				Effect.flatMap((d) =>
					d.judge({
						state: {},
						questions: [{ id: "q", kind: "noul", text: "?" }],
					}),
				),
				Effect.provide(layer!),
			),
		);
		expect(out.answers).toEqual([]);
		expect(captured[0]).toMatchObject({ kind: "systemone", baseUrl: "http://127.0.0.1:8009" });
		await rt.dispose();
	});

	it("ignores generative platform defaults and non-platform systemone rows", async () => {
		const { rt, run } = make({ decisionsFactory: "ok" });
		await seed(
			run,
			{ ...EP, name: "gen default", scope: "platform", isDefault: true },
			{
				name: "eval-scope judge",
				kind: "systemone",
				baseUrl: "http://127.0.0.1:8009",
				isDefault: true,
			},
		);
		expect(await run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer()))).toBeNull();
		await rt.dispose();
	});

	it("answers null without a factory, without a default, and on resolve failure", async () => {
		const bare = make();
		await seed(bare.run, {
			name: "judge",
			kind: "systemone",
			baseUrl: "http://127.0.0.1:8009",
			scope: "platform",
			isDefault: true,
		});
		expect(await bare.run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer()))).toBeNull();
		await bare.rt.dispose();

		const none = make({ decisionsFactory: "ok" });
		expect(await none.run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer()))).toBeNull();
		await none.rt.dispose();

		const failing = make({ decisionsFactory: "fail" });
		await seed(failing.run, {
			name: "judge",
			kind: "systemone",
			baseUrl: "http://127.0.0.1:8009",
			scope: "platform",
			isDefault: true,
		});
		expect(
			await failing.run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer())),
		).toBeNull();
		await failing.rt.dispose();
	});

	it("a systemone platform default does not leak into PlatformLlm", async () => {
		const { rt, run } = make({
			factory: "ok",
			decisionsFactory: "ok",
		});
		await seed(run, {
			name: "judge",
			kind: "systemone",
			baseUrl: "http://127.0.0.1:8009",
			scope: "platform",
			isDefault: true,
		});
		// PlatformLlm filters kind != systemone → null (env fallback),
		// while PlatformDecisions resolves the same row.
		expect(await run(Effect.flatMap(PlatformLlm, (s) => s.defaultLayer()))).toBeNull();
		expect(await run(Effect.flatMap(PlatformDecisions, (s) => s.defaultLayer()))).not.toBeNull();
		await rt.dispose();
	});
});
