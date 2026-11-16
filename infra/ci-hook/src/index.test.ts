import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index.ts";

const SECRET = "test-secret";
const encoder = new TextEncoder();

async function sign(body: string, secret = SECRET): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeEnv(overrides: Partial<Env> = {}): Env {
	return { GITHUB_WEBHOOK_SECRET: SECRET, ...overrides };
}

async function post(
	body: string,
	event = "push",
	signature?: string | null,
	env: Env = makeEnv(),
): Promise<Response> {
	const headers: Record<string, string> = { "X-GitHub-Event": event };
	const sig = signature === undefined ? await sign(body) : signature;
	if (sig !== null) headers["X-Hub-Signature-256"] = sig;
	return worker.fetch(new Request("https://ci.example/", { method: "POST", headers, body }), env);
}

const workflowRun = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		action: "completed",
		repository: { full_name: "ktbhealth/product" },
		workflow_run: {
			name: "ci",
			conclusion: "failure",
			html_url: "https://github.com/x/run/1",
			head_branch: "main",
		},
		...overrides,
	});

describe("ci-hook worker", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("answers GET /health", async () => {
		const res = await worker.fetch(new Request("https://ci.example/health"), makeEnv());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, service: "ci-hook" });
	});

	it("404s non-webhook routes and methods", async () => {
		const res = await worker.fetch(
			new Request("https://ci.example/nope", { method: "POST" }),
			makeEnv(),
		);
		expect(res.status).toBe(404);
	});

	it("rejects missing, malformed and wrong signatures", async () => {
		const body = "{}";
		expect((await post(body, "push", null)).status).toBe(401);
		expect((await post(body, "push", "sha1=abc")).status).toBe(401);
		expect((await post(body, "push", "sha256=short")).status).toBe(401);
		expect((await post(body, "push", await sign(body, "other-secret"))).status).toBe(401);
	});

	it("acknowledges ping", async () => {
		const res = await post("{}", "ping");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("acks requests without an event header", async () => {
		const body = "{}";
		const res = await worker.fetch(
			new Request("https://ci.example/", {
				method: "POST",
				headers: { "X-Hub-Signature-256": await sign(body) },
				body,
			}),
			makeEnv(),
		);
		expect(res.status).toBe(200);
	});

	it("400s on invalid JSON", async () => {
		expect((await post("not-json{")).status).toBe(400);
	});

	it("acks non-workflow_run events without notifying", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = makeEnv({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });
		const res = await post(JSON.stringify({ action: "opened" }), "pull_request", undefined, env);
		expect(res.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores workflow_run events that are not completed failures", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = makeEnv({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });
		for (const payload of [
			workflowRun({ action: "requested" }),
			workflowRun({ workflow_run: { conclusion: null } }),
			workflowRun({ workflow_run: { conclusion: "success" } }),
			workflowRun({ workflow_run: { conclusion: "skipped" } }),
			workflowRun({ workflow_run: { conclusion: "neutral" } }),
		]) {
			const res = await post(payload, "workflow_run", undefined, env);
			expect(res.status).toBe(200);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not notify when ntfy is not configured", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const env of [
			makeEnv(),
			makeEnv({ NTFY_URL: "https://ntfy.example" }),
			makeEnv({ NTFY_TOPIC: "ci" }),
		]) {
			await post(workflowRun(), "workflow_run", undefined, env);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("notifies ntfy on workflow failure with high priority", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const env = makeEnv({
			NTFY_URL: "https://ntfy.example",
			NTFY_TOPIC: "ci",
			NTFY_AUTH: "Bearer tk_x",
		});
		const res = await post(workflowRun(), "workflow_run", undefined, env);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ntfy.example/ci",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Title: "CI failure: ktbhealth/product",
					Priority: "high",
					Authorization: "Bearer tk_x",
				}),
			}),
		);
	});

	it("uses default priority and auth token for non-failure conclusions", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const env = makeEnv({
			NTFY_URL: "https://ntfy.example",
			NTFY_TOPIC: "ci",
			NTFY_AUTH_TOKEN: "tk_y",
		});
		await post(
			workflowRun({ workflow_run: { conclusion: "cancelled", name: undefined } }),
			"workflow_run",
			undefined,
			env,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ntfy.example/ci",
			expect.objectContaining({
				headers: expect.objectContaining({
					Priority: "default",
					Authorization: "Bearer tk_y",
					Title: "CI cancelled: ktbhealth/product",
				}),
			}),
		);
	});

	it("falls back for missing payload fields", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const env = makeEnv({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });
		await post(
			JSON.stringify({ action: "completed", workflow_run: { conclusion: "timed_out" } }),
			"workflow_run",
			undefined,
			env,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ntfy.example/ci",
			expect.objectContaining({
				headers: expect.objectContaining({ Title: "CI timed_out: ?" }),
			}),
		);
	});
});
