import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => ({
	...reactStartServerMock(),
	getRequestUrl: () => "https://app.test/req",
}));
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { LlmFactory } from "@ktb/eval-consultation";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { AI_ENDPOINTS_TEST_DDL, AiEndpointsLive } from "./index.ts";
import {
	createBridgeLinkFn,
	deleteEndpointFn,
	endpointBridgeStatusFn,
	listAgentLinksFn,
	listEndpointPresetsFn,
	listEndpointsFn,
	revokeAgentLinkFn,
	saveEndpointFn,
	setPlatformDefaultEndpointFn,
	testEndpointFn,
} from "./fns.ts";

describe("ai-endpoints fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	let allow = true;
	let factoryFails: false | "port" | "raw" = false;

	beforeAll(() => {
		const db = makeDb(makeD1(AI_ENDPOINTS_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(
				Permissions,
				Permissions.of({
					permissionsFor: () => Effect.succeed(new Map()),
					canFor: () => Effect.succeed(allow),
					can: () => Effect.succeed(allow),
					requirePermissionFor: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					requirePermission: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					invalidate: () => Effect.void,
				} as never),
			),
			Layer.succeed(
				LlmFactory,
				LlmFactory.of({
					resolve: () => Effect.die("unused") as never,
					test: () =>
						factoryFails === "port"
							? (Effect.fail({ _tag: "PortError", port: "l", message: "down" }) as never)
							: factoryFails === "raw"
								? (Effect.fail("raw outage") as never)
								: Effect.void,
				}),
			),
		);
		runtime = ManagedRuntime.make(
			Layer.merge(AiEndpointsLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		installServerFnRuntime(runtime, auth, {
			// Dev-style argv prefix — the repo's unpublished CLI source.
			aiBridgeCli: "bun /repo/packages/ai-bridge/src/cli.ts",
		});
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(listEndpointsFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(listEndpointPresetsFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(testEndpointFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(setPlatformDefaultEndpointFn({ data: { id: 1 } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(createBridgeLinkFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(endpointBridgeStatusFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
		await expect(listAgentLinksFn({ data: undefined })).rejects.toThrow("unauthenticated");
		await expect(revokeAgentLinkFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await listEndpointsFn({ data: undefined })).toEqual({ ok: false });
		expect(await listEndpointPresetsFn({ data: undefined })).toEqual({ ok: false });
		expect(await saveEndpointFn({ data: { name: "x", kind: "openai", baseUrl: "u" } })).toEqual({
			ok: false,
		});
		expect(await deleteEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await testEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await setPlatformDefaultEndpointFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await createBridgeLinkFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await endpointBridgeStatusFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await listAgentLinksFn({ data: undefined })).toEqual({ ok: false });
		expect(await revokeAgentLinkFn({ data: { id: 1 } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives the endpoint CRUD + test through the fn surface", async () => {
		const created = await saveEndpointFn({
			data: {
				name: "Ollama",
				kind: "openai",
				baseUrl: "http://localhost:11434/v1",
				model: "qwen",
				sessionId: "s",
				secretRef: "KEY",
				transport: null,
				scope: "eval",
				isDefault: true,
				timeoutMs: 5000,
				enabled: true,
			},
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.data.id;

		expect(
			await saveEndpointFn({
				data: {
					id,
					name: "O2",
					kind: "acp",
					baseUrl: "u2",
					transport: "ssh",
					agentCmd: "claude-agent-acp",
					sshHost: "me@gpu-box",
				},
			}),
		).toEqual({
			ok: true,
			data: { id },
		});
		const listed = await listEndpointsFn({ data: undefined });
		expect(listed.ok && listed.data[0]?.kind).toBe("acp");
		expect(listed.ok && listed.data[0]).toMatchObject({
			agentCmd: "claude-agent-acp",
			sshHost: "me@gpu-box",
		});

		// The stub factory declares no presets — the fn degrades to [].
		expect(await listEndpointPresetsFn({ data: undefined })).toEqual({ ok: true, data: [] });

		// Required-fields-only create — no optionals on the wire.
		expect(
			await saveEndpointFn({ data: { name: "bare-ep", kind: "openai", baseUrl: "u" } }),
		).toMatchObject({ ok: true });

		expect(await setPlatformDefaultEndpointFn({ data: { id } })).toEqual({
			ok: true,
			data: null,
		});
		const promoted = await listEndpointsFn({ data: undefined });
		expect(promoted.ok && promoted.data.find((e) => e.id === id)).toMatchObject({
			scope: "platform",
			isDefault: true,
		});

		const okTest = await testEndpointFn({ data: { id } });
		expect(okTest.ok).toBe(true);
		factoryFails = "port";
		const badTest = await testEndpointFn({ data: { id } });
		expect(badTest).toEqual({ ok: false, data: { message: "down" } });
		factoryFails = "raw";
		const rawTest = await testEndpointFn({ data: { id } });
		expect(rawTest).toEqual({ ok: false, data: { message: "raw outage" } });
		factoryFails = false;

		expect(await deleteEndpointFn({ data: { id } })).toEqual({ ok: true, data: null });
	});

	it("mints the bridge command once and polls bridge status through the fn surface", async () => {
		currentEmail = "v@x.com";
		allow = true;
		const created = await saveEndpointFn({
			data: { name: "agent", kind: "acp", transport: "ws", baseUrl: "", enabled: true },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.data.id;

		// No minted link yet — the bridge endpoint reads offline.
		expect(await endpointBridgeStatusFn({ data: { id } })).toEqual({
			ok: true,
			data: { status: "offline", lastSeenAt: null },
		});

		const link = await createBridgeLinkFn({ data: { id } });
		expect(link.ok).toBe(true);
		if (!link.ok || link.data === null) return;
		expect(link.data.command).toContain("bun /repo/packages/ai-bridge/src/cli.ts connect ");
		expect(link.data.command).toContain("https://app.test/api/ai/bridge?token=");
		expect(link.data.command).toContain('--cmd "bunx @agentclientprotocol/claude-agent-acp"');
		expect(link.data.expiresAt).toBeInstanceOf(Date);

		// A minted-but-unconsumed link flips the badge to waiting.
		expect(await endpointBridgeStatusFn({ data: { id } })).toEqual({
			ok: true,
			data: { status: "waiting", lastSeenAt: null },
		});

		// Non-bridge and unknown endpoints resolve to null data.
		const openai = await saveEndpointFn({
			data: { name: "o", kind: "openai", baseUrl: "http://x/v1" },
		});
		expect(openai.ok).toBe(true);
		if (!openai.ok) return;
		expect(await endpointBridgeStatusFn({ data: { id: openai.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		expect(await createBridgeLinkFn({ data: { id: openai.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		expect(await endpointBridgeStatusFn({ data: { id: 9999 } })).toEqual({
			ok: true,
			data: null,
		});
	});

	it("falls back to the published ai-bridge CLI when the runtime has no override", async () => {
		// Same runtime shape as beforeAll, minus aiBridgeCli — exercises the
		// `?? "bunx @ktb/ai-bridge"` fallback in the bridge command.
		installServerFnRuntime(runtime, auth);

		currentEmail = "v@x.com";
		allow = true;
		const created = await saveEndpointFn({
			data: { name: "agent2", kind: "acp", transport: "ws", baseUrl: "", enabled: true },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const link = await createBridgeLinkFn({ data: { id: created.data.id } });
		expect(link.ok).toBe(true);
		if (!link.ok || link.data === null) return;
		expect(link.data.command.startsWith("bunx @ktb/ai-bridge connect ")).toBe(true);

		// Restore the beforeAll runtime for later tests.
		installServerFnRuntime(runtime, auth, {
			// Dev-style argv prefix — the repo's unpublished CLI source.
			aiBridgeCli: "bun /repo/packages/ai-bridge/src/cli.ts",
		});
	});

	it("lists agent links without token material and revokes them through the fn surface", async () => {
		currentEmail = "v@x.com";
		allow = true;
		const created = await saveEndpointFn({
			data: { name: "agent-f4", kind: "acp", transport: "ws", baseUrl: "", enabled: true },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const endpointId = created.data.id;

		const minted = await createBridgeLinkFn({ data: { id: endpointId } });
		expect(minted.ok && minted.data !== null).toBe(true);
		if (!minted.ok || minted.data === null) return;

		const listed = await listAgentLinksFn({ data: undefined });
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		const link = listed.data.find((l) => l.endpointId === endpointId);
		expect(link).toMatchObject({
			endpointId,
			endpointName: "agent-f4",
			status: "waiting",
			usedAt: null,
			lastSeenAt: null,
		});
		// token_hash never crosses the wire; the raw token only ever
		// existed inside the minted command.
		expect(link).not.toHaveProperty("tokenHash");
		expect(JSON.stringify(link)).not.toContain(
			minted.data.command.split("token=")[1]!.split(" ")[0]!,
		);

		// Revoke → status flips; a second revoke reports revoked: false.
		expect(await revokeAgentLinkFn({ data: { id: link!.id } })).toEqual({
			ok: true,
			data: { revoked: true },
		});
		expect(await revokeAgentLinkFn({ data: { id: link!.id } })).toEqual({
			ok: true,
			data: { revoked: false },
		});
		expect(await revokeAgentLinkFn({ data: { id: 9999 } })).toEqual({
			ok: true,
			data: { revoked: false },
		});
		const after = await listAgentLinksFn({ data: undefined });
		expect(after.ok && after.data.find((l) => l.id === link!.id)?.status).toBe("revoked");
	});
});
