/**
 * factory.ts — `LlmFactory` driver: resolves endpoint descriptors
 * (the eval lab's CRUD rows) into concrete LlmPort layers.
 *
 * Always eligible — the factory itself has no env requirement; each
 * descriptor carries its own baseUrl/kind. `secretRef` names an env
 * var resolved HERE (the adapter edge, where process access is
 * allowed) — the plugin only ever sees the name, never the key.
 *
 * Dispatch (F3a): openai → @ktb/ai-adapter-openai, acp+ws →
 * @ktb/ai-adapter-acp, acp+child/ssh → @ktb/ai-adapter-node (which
 * fails typed under workerd — it can't spawn).
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	makeAcpLlm,
	makeBridgeAcpLlm,
	makeHttpAcpTransport,
	type BridgeNamespace,
} from "@ktb/ai-adapter-acp";
import { resolveNodeAcp } from "@ktb/ai-adapter-node";
import { makeChatLlm } from "@ktb/ai-adapter-openai";
import type { Driver } from "@ktb/driver-framework";

import { PortError } from "@ktb/eval-core";
import {
	fnvHex,
	LlmFactory,
	LlmPort,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";

const DEFAULT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;

const resolveDescriptor = (
	d: LlmEndpointDescriptor,
	bridge: BridgeNamespace | undefined,
): Effect.Effect<Layer.Layer<LlmPort>, PortError> => {
	const timeoutMs = d.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	switch (d.kind) {
		case "acp": {
			const transport = d.transport ?? "ws";
			if (transport !== "ws") {
				// child/ssh spawn a local agent process — the Node-runtime
				// adapter's job; it fails typed under workerd.
				return resolveNodeAcp(d);
			}
			if (d.baseUrl.trim() === "") {
				// F3b bridge endpoint: the agent lives behind a local
				// `ai-bridge` CLI holding an outbound socket to the
				// AcpBridge DO (`idFromName(endpointId)`) — there is no URL
				// to dial. The namespace binding only exists under
				// workerd; Node/dev without it fails typed.
				if (d.endpointId === undefined) {
					return Effect.fail(
						new PortError({
							port: "llm",
							message: "acp+ws bridge endpoints require endpointId (the DO's name)",
						}),
					);
				}
				if (bridge === undefined) {
					return Effect.fail(
						new PortError({
							port: "llm",
							message:
								"acp+ws bridge endpoints require the ACP_BRIDGE binding — set baseUrl for a direct HTTP agent instead",
						}),
					);
				}
				return Effect.succeed(
					makeBridgeAcpLlm({
						ns: bridge,
						endpointId: d.endpointId,
						...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
						timeoutMs,
					}),
				);
			}
			return Effect.succeed(
				makeAcpLlm({
					transport: makeHttpAcpTransport(d.baseUrl, fetch, timeoutMs),
					...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
					timeoutMs,
					engineVersion: fnvHex(d.baseUrl),
				}),
			);
		}
		case "openai": {
			if (d.model === undefined || d.model.trim() === "") {
				return Effect.fail(
					new PortError({ port: "llm", message: "openai endpoints require a model" }),
				);
			}
			// Edge-only env read: the endpoint row stores the env var
			// NAME (`secretRef`), never the credential itself.
			const apiKey = d.apiKey ?? (d.secretRef !== undefined ? process.env[d.secretRef] : undefined);
			return Effect.succeed(
				makeChatLlm({
					baseUrl: d.baseUrl,
					model: d.model,
					...(apiKey !== undefined ? { apiKey } : {}),
					...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
					timeoutMs,
				}),
			);
		}
		default:
			return Effect.fail(
				new PortError({
					port: "llm",
					message: `unknown endpoint kind: ${JSON.stringify(d.kind)}`,
				}),
			);
	}
};

/** Provider starter endpoints for the eval lab's endpoint dialog.
 * Hosted-provider URLs live HERE (the adapter edge) — the arch preset's
 * provider-lockin keeps them out of port/domain code. */
const PRESETS: readonly LlmEndpointPreset[] = [
	{
		label: "OpenAI",
		kind: "openai",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
	},
];

/** Driver for `LlmFactory` — always eligible; each descriptor
 * resolves its own transport. Without it the eval lab can still use
 * the template renderer (plugin treats the port as optional). */
export const evalLlmFactoryDriver: Driver = {
	id: "eval-llm-factory",
	port: LlmFactory.key,
	provides: (env) => {
		// The composition root passes the worker env verbatim — under
		// workerd `ACP_BRIDGE` is the AcpBridge DO namespace (F3b);
		// absent (Node dev, tests) bridge endpoints fail typed at
		// resolve time instead of here.
		const bridge = (env as { readonly ACP_BRIDGE?: BridgeNamespace } | undefined)?.ACP_BRIDGE;
		const resolve = (d: LlmEndpointDescriptor) => resolveDescriptor(d, bridge);
		return Layer.succeed(
			LlmFactory,
			LlmFactory.of({
				resolve,
				presets: PRESETS,
				test: (d) =>
					resolve(d).pipe(
						Effect.flatMap((layer) =>
							Effect.flatMap(LlmPort, (llm) =>
								llm.generate({
									taskId: "endpoint-test",
									role: "generator",
									input: "Reply with the single word: ok",
									outputSchema: "Text",
								}),
							).pipe(
								Effect.provide(layer),
								// A ping shouldn't burn the configured generation
								// budget — 15s is enough to prove liveness.
								Effect.timeout(`${TEST_TIMEOUT_MS} millis`),
								/* v8 ignore next 4 -- else arm only fires on raw timeout defects */
								Effect.mapError((e) =>
									e instanceof PortError
										? e
										: new PortError({ port: "llm", message: "endpoint test timed out", cause: e }),
								),
							),
						),
						Effect.asVoid,
					),
			}),
		);
	},
};
