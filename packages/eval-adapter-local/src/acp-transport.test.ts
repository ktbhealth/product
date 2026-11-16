import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { PortError } from "@ktb/eval-core";
import type { AcpRequest } from "@ktb/eval-consultation";

import { makeHttpAcpTransport } from "./acp-transport.ts";

const REQUEST: AcpRequest = {
	jsonrpc: "2.0",
	id: "t-1",
	method: "task",
	params: { kind: "generate" },
} as unknown as AcpRequest;

const jsonResponse = (body: unknown, init?: { status?: number; statusText?: string }) =>
	new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "Content-Type": "application/json" },
	});

describe("makeHttpAcpTransport", () => {
	it("POSTs the JSON-RPC request and returns the decoded body", async () => {
		const calls: { url: string; method?: string; body?: string }[] = [];
		const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				method: init?.method,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return jsonResponse({ jsonrpc: "2.0", id: "t-1", result: { payload: "ok" } });
		}) as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local/", fetchImpl);
		const res = await Effect.runPromise(t(REQUEST));
		expect(res).toMatchObject({ result: { payload: "ok" } });
		// Trailing slash is stripped from the base URL.
		expect(calls[0]?.url).toBe("http://acp.local");
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]!.body!)).toMatchObject({ id: "t-1", method: "task" });
	});

	it("a non-2xx response fails as PortError with the status only — never the body", async () => {
		const fetchImpl = (async () => new Response("agent exploded", { status: 502 })) as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local", fetchImpl);
		const err = await Effect.runPromise(Effect.flip(t(REQUEST)));
		expect(err).toBeInstanceOf(PortError);
		// The body is remote-controlled content: it must not reach the
		// wire-visible message (server logs carry it instead).
		expect((err as PortError).message).toBe("acp 502");
	});

	it("an unreadable error body still fails as PortError with the status only", async () => {
		const fetchImpl = (async () => ({
			ok: false,
			status: 502,
			text: async () => {
				throw new Error("stream reset");
			},
		})) as unknown as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local", fetchImpl);
		const err = await Effect.runPromise(Effect.flip(t(REQUEST)));
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toBe("acp 502");
	});

	it("an undecodable response body wraps as PortError 'acp response'", async () => {
		const fetchImpl = (async () => new Response("<<not json>>", { status: 200 })) as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local", fetchImpl);
		const err = await Effect.runPromise(Effect.flip(t(REQUEST)));
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("acp response:");
	});

	it("a network/abort failure wraps as PortError 'acp transport'", async () => {
		const fetchImpl = (async () => {
			throw new Error("socket hangup");
		}) as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local", fetchImpl);
		const err = await Effect.runPromise(Effect.flip(t(REQUEST)));
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("acp transport: socket hangup");
	});

	it("non-Error causes still wrap as PortError via String()", async () => {
		const fetchImpl = (async () => {
			throw "plain string failure"; // eslint-disable-line no-throw-literal
		}) as typeof fetch;
		const t = makeHttpAcpTransport("http://acp.local", fetchImpl);
		const err = await Effect.runPromise(Effect.flip(t(REQUEST)));
		expect((err as PortError).message).toContain("plain string failure");
	});
});
