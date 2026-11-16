import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index.ts";

const SECRET = "whsec_test";

const env = (extra: Partial<Env> = {}): Env => ({
	GITHUB_WEBHOOK_SECRET: SECRET,
	...extra,
});

/** Real HMAC-SHA256 signature, same shape GitHub sends. */
async function sign(body: string, secret = SECRET): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const reqHeaders = (call: { init?: RequestInit } | undefined): Record<string, string> =>
	(call?.init?.headers ?? {}) as Record<string, string>;

function hookRequest(body: string, headers: Record<string, string> = {}): Request {
	return new Request("https://ci.ktbhealth.workers.dev/", {
		method: "POST",
		headers,
		body,
	});
}

async function postJson(
	payload: unknown,
	event = "workflow_run",
	e: Env = env(),
): Promise<Response> {
	const body = JSON.stringify(payload);
	return worker.fetch(
		hookRequest(body, {
			"X-Hub-Signature-256": await sign(body),
			"X-GitHub-Event": event,
		}),
		e,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("ci-hook worker", () => {
	it("answers GET /health and rejects everything else that is not POST /", async () => {
		const health = await worker.fetch(
			new Request("https://ci.ktbhealth.workers.dev/health"),
			env(),
		);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true, service: "ci-hook" });

		for (const req of [
			new Request("https://ci.ktbhealth.workers.dev/"),
			new Request("https://ci.ktbhealth.workers.dev/other"),
			new Request("https://ci.ktbhealth.workers.dev/other", { method: "POST" }),
			new Request("https://ci.ktbhealth.workers.dev/hook", { method: "POST" }),
		]) {
			expect((await worker.fetch(req, env())).status).toBe(404);
		}
	});

	it("rejects missing, malformed and wrong signatures with 401", async () => {
		expect((await worker.fetch(hookRequest("{}"), env())).status).toBe(401);
		expect(
			(await worker.fetch(hookRequest("{}", { "X-Hub-Signature-256": "sha1=abcd" }), env())).status,
		).toBe(401);
		// Right prefix, wrong bytes — same length compare path.
		expect(
			(
				await worker.fetch(
					hookRequest("{}", { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }),
					env(),
				)
			).status,
		).toBe(401);
		// Truncated signature — the length shortcut.
		expect(
			(await worker.fetch(hookRequest("{}", { "X-Hub-Signature-256": "sha256=00" }), env())).status,
		).toBe(401);
		// Signature for a different secret — every byte compared.
		expect(
			(
				await worker.fetch(
					hookRequest("{}", {
						"X-Hub-Signature-256": await sign("{}", "other-secret"),
					}),
					env(),
				)
			).status,
		).toBe(401);
	});

	it("acks ping and ignores non-workflow_run events", async () => {
		const body = "{}";
		const ping = await worker.fetch(
			hookRequest(body, {
				"X-Hub-Signature-256": await sign(body),
				"X-GitHub-Event": "ping",
			}),
			env(),
		);
		expect(await ping.json()).toEqual({ ok: true });

		expect((await postJson({ zen: "x" }, "push")).status).toBe(200);
	});

	it("acks a signed POST with no X-GitHub-Event header", async () => {
		const body = JSON.stringify({ action: "completed" });
		const res = await worker.fetch(
			hookRequest(body, { "X-Hub-Signature-256": await sign(body) }),
			env(),
		);
		expect(res.status).toBe(200);
	});

	it("returns 400 on malformed JSON payloads", async () => {
		const body = "{not json";
		const res = await worker.fetch(
			hookRequest(body, {
				"X-Hub-Signature-256": await sign(body),
				"X-GitHub-Event": "workflow_run",
			}),
			env(),
		);
		expect(res.status).toBe(400);
	});

	it("notifies ntfy only on failed workflow_run conclusions", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return new Response("ok");
		});
		const e = env({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });

		const run = (conclusion: string | null, action = "completed") => ({
			action,
			repository: { full_name: "ktbhealth/product" },
			workflow_run: {
				name: "ci",
				conclusion,
				html_url: "https://run",
				head_branch: "main",
			},
		});

		// Nothing worth alerting: in-progress action, missing conclusion,
		// success, skipped, neutral — and a payload without workflow_run.
		for (const payload of [
			run("failure", "requested"),
			run(null),
			run("success"),
			run("skipped"),
			run("neutral"),
			{ action: "completed" },
		]) {
			expect((await postJson(payload, "workflow_run", e)).status).toBe(200);
		}
		expect(calls).toHaveLength(0);

		// failure → high priority; other non-success conclusions → default.
		expect((await postJson(run("failure"), "workflow_run", e)).status).toBe(200);
		expect((await postJson(run("cancelled"), "workflow_run", e)).status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toBe("https://ntfy.example/ci");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(reqHeaders(calls[0]).Priority).toBe("high");
		expect(reqHeaders(calls[0]).Title).toContain("CI failure: ktbhealth/product");
		expect(calls[0]?.init?.body).toContain("ci on main — https://run");
		expect(reqHeaders(calls[1]).Priority).toBe("default");
	});

	it("falls back to '?' placeholders when payload fields are missing", async () => {
		const calls: { init?: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			calls.push({ init });
			return new Response("ok");
		});
		const e = env({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });
		await postJson(
			{ action: "completed", workflow_run: { conclusion: "failure" } },
			"workflow_run",
			e,
		);
		expect(reqHeaders(calls[0]).Title).toContain("?");
		expect(calls[0]?.init?.body).toContain("workflow on ?");
	});

	it("sends no ntfy request without NTFY_URL/NTFY_TOPIC and maps auth env vars", async () => {
		const calls: { init?: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			calls.push({ init });
			return new Response("ok");
		});
		const failed = {
			action: "completed",
			workflow_run: { conclusion: "failure" },
		};

		// Missing both config vars → early return, no fetch at all.
		for (const e of [env({ NTFY_TOPIC: "ci" }), env({ NTFY_URL: "https://ntfy.example" }), env()]) {
			await postJson(failed, "workflow_run", e);
		}
		expect(calls).toHaveLength(0);

		// Full Authorization header wins over the token shortcut.
		await postJson(
			failed,
			"workflow_run",
			env({
				NTFY_URL: "https://ntfy.example",
				NTFY_TOPIC: "ci",
				NTFY_AUTH: "Basic abc",
				NTFY_AUTH_TOKEN: "tk_ignored",
			}),
		);
		expect(reqHeaders(calls[0]).Authorization).toBe("Basic abc");

		// Token alone becomes a Bearer header.
		await postJson(
			failed,
			"workflow_run",
			env({
				NTFY_URL: "https://ntfy.example",
				NTFY_TOPIC: "ci",
				NTFY_AUTH_TOKEN: "tk_1",
			}),
		);
		expect(reqHeaders(calls[1]).Authorization).toBe("Bearer tk_1");
	});
});
