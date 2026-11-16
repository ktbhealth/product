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
		Effect.tryPromise({
			try: async () => {
				const res = await fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					signal: AbortSignal.timeout(timeoutMs),
					body: JSON.stringify(request),
				});
				if (!res.ok) {
					throw new PortError({
						port: "llm",
						message: `acp ${res.status}: ${(await res.text()).slice(0, 300)}`,
					});
				}
				return (await res.json()) as unknown;
			},
			catch: (cause) =>
				cause instanceof PortError
					? cause
					: new PortError({
							port: "llm",
							message: `acp transport: ${causeMessage(cause)}`,
							cause,
						}),
		});
};
