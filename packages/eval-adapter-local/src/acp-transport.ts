/**
 * acp-transport.ts — minimal JSON-RPC transport for the ACP adapter
 * (T-104). POSTs the encoded `AcpRequest` to a base URL and hands the
 * decoded body back for `decodeTaskResult` validation. Lives in the
 * adapter package so apps AND app-host drivers can wire it — apps are
 * composition roots, not libraries.
 */

import * as Effect from "effect/Effect";

import { PortError } from "@ktb/eval-consultation";

import type { AcpTransport } from "./llm.ts";

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/** POST JSON-RPC to `baseUrl`; the AbortSignal mirrors the caller's
 * Effect.timeout so a hung agent never leaks the socket. */
export const makeHttpAcpTransport = (
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 60_000,
): AcpTransport => {
	const url = baseUrl.replace(/\/+$/, "");
	return (request) =>
		Effect.gen(function* () {
			const res = yield* Effect.tryPromise({
				try: () =>
					fetchImpl(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						signal: AbortSignal.timeout(timeoutMs),
						body: JSON.stringify(request),
					}),
				catch: (cause) =>
					new PortError({
						port: "llm",
						message: `acp transport: ${causeMessage(cause)}`,
						cause,
					}),
			});
			if (!res.ok) {
				// Agent error bodies are remote-controlled content — keep
				// them out of the wire-visible PortError message; they stay
				// in server logs.
				const body = yield* Effect.promise(() => res.text().catch(() => ""));
				yield* Effect.logWarning(`acp endpoint ${res.status} response body`).pipe(
					Effect.annotateLogs({ body: body.slice(0, 300) }),
				);
				return yield* new PortError({ port: "llm", message: `acp ${res.status}` });
			}
			return (yield* Effect.tryPromise({
				try: () => res.json(),
				catch: (cause) =>
					new PortError({
						port: "llm",
						message: `acp response: ${causeMessage(cause)}`,
						cause,
					}),
			})) as unknown;
		});
};
