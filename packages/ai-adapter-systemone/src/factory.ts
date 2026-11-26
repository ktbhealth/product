/**
 * factory.ts — `DecisionsFactory` driver: resolves `systemone`
 * endpoint descriptors (the ai_endpoint rows of kind `systemone`)
 * into concrete DecisionsPort layers.
 *
 * Always eligible — the factory itself has no env requirement; each
 * descriptor carries its own baseUrl/kind. `secretRef` names an env
 * var resolved HERE against the deployment env the composition root
 * passes to `provides` (workerd-safe: env bindings arrive as plain
 * properties, never `process.env`); `apiKey` arrives pre-resolved
 * when the row's secretRef pointed at the credentials/vault stores —
 * the plugin injects it server-side and it never touches a table.
 *
 * Dispatch: kind `systemone` → makeSystemOneDecisions (the TypeSafe
 * `/v1/systemone` wire). Every other kind fails typed — generative
 * endpoints are LlmFactory's job, not this port's.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Driver } from "@ktb/driver-framework";

import { DecisionsPort, PortError } from "@ktb/eval-core";
import {
	DecisionsFactory,
	type LlmEndpointDescriptor,
	type LlmEndpointPreset,
} from "@ktb/eval-consultation";

import { makeSystemOneDecisions } from "./systemone.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Liveness ping budget — same contract as LlmFactory.test: enough
 * to prove the endpoint answers, never the full generation budget. */
const TEST_TIMEOUT_MS = 15_000;

const fail = (message: string) => new PortError({ port: "decisions", message });

/** `secretRef` is an env var NAME — resolved against the env object
 * the composition root hands every driver (`provides(env)`). Only
 * string values count; absent/empty/non-string resolves to no key. */
const envSecret =
	(env: unknown) =>
	(name: string): string | undefined => {
		const value = (env as Record<string, unknown> | null | undefined)?.[name];
		return typeof value === "string" && value !== "" ? value : undefined;
	};

const resolveDescriptor = (
	d: LlmEndpointDescriptor,
	env: unknown,
): Effect.Effect<Layer.Layer<DecisionsPort>, PortError> => {
	if (d.kind !== "systemone") {
		return Effect.fail(
			fail(`DecisionsFactory resolves systemone endpoints only, got kind "${d.kind}"`),
		);
	}
	if (d.baseUrl.trim() === "") {
		return Effect.fail(fail("systemone endpoints require a baseUrl"));
	}
	const apiKey = d.apiKey ?? (d.secretRef !== undefined ? envSecret(env)(d.secretRef) : undefined);
	return Effect.succeed(
		makeSystemOneDecisions({
			baseUrl: d.baseUrl,
			...(d.model !== undefined ? { model: d.model } : {}),
			...(apiKey !== undefined ? { apiKey } : {}),
			timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			fetchImpl: fetch,
		}),
	);
};

/** Provider starter endpoints for the endpoint dialog's preset chips.
 * The local OpenJev default mirrors the eval CLI's
 * `local-systemone` profile (`wev serve --port 8009`); hosted
 * TypeSafe endpoints are entered manually since their baseUrl is
 * account-specific. */
const PRESETS: readonly LlmEndpointPreset[] = [
	{
		label: "System One (OpenJev local)",
		kind: "systemone",
		baseUrl: "http://127.0.0.1:8009",
		model: "wev-latest",
	},
];

/** Driver for `DecisionsFactory` — always eligible; each descriptor
 * resolves its own transport. Without it the ai-provider plugin's
 * PlatformDecisions resolves null and consumers fall back to their
 * env-derived decision config. */
export const systemOneDecisionsDriver: Driver = {
	id: "systemone-decisions-factory",
	port: DecisionsFactory.key,
	provides: (env) => {
		const resolve = (d: LlmEndpointDescriptor) => resolveDescriptor(d, env);
		return Layer.succeed(
			DecisionsFactory,
			DecisionsFactory.of({
				resolve,
				presets: PRESETS,
				test: (d) =>
					resolve(d).pipe(
						Effect.flatMap((layer) =>
							DecisionsPort.pipe(
								Effect.flatMap((decisions) =>
									decisions.judge({
										state: { probe: "endpoint-test" },
										questions: [
											{
												id: "alive",
												kind: "noul",
												text: "Is this decision service responding?",
											},
										],
									}),
								),
								// A ping shouldn't burn the configured decision
								// budget — 15s is enough to prove liveness.
								Effect.timeout(`${TEST_TIMEOUT_MS} millis`),
								Effect.mapError((e) =>
									e instanceof PortError
										? e
										: new PortError({
												port: "decisions",
												message: "endpoint test timed out",
												cause: e,
											}),
								),
								Effect.provide(layer),
							),
						),
						Effect.asVoid,
					),
			}),
		);
	},
};
