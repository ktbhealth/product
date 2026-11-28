import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

function postToken(env: Env, body?: string, auth?: string | null): Promise<Response> {
	const headers: Record<string, string> = {};
	if (auth != null) headers.Authorization = auth;
	return worker.fetch(
		new Request("https://ci.example/token", { method: "POST", headers, body }),
		env,
	);
}

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

	it("still 200s when the ntfy notify fetch throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ntfy unreachable");
			}),
		);
		const env = makeEnv({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "ci" });
		const res = await post(workflowRun(), "workflow_run", undefined, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
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

describe("token broker (POST /token)", () => {
	let appKeyPem: string;

	const tokenEnv = (overrides: Partial<Env> = {}): Env =>
		makeEnv({
			TOKEN_MINT_SECRET: "mint-secret",
			GITHUB_APP_ID: "1234",
			GITHUB_APP_INSTALLATION_ID: "5678",
			...overrides,
		});

	beforeAll(async () => {
		const { privateKey } = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign"],
		)) as CryptoKeyPair;
		const der = (await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer;
		const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
		const lines = b64.match(/.{1,64}/g) ?? [b64];
		appKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
	});

	it("rejects missing, non-Bearer and wrong tokens with 401", async () => {
		const env = tokenEnv({ GITHUB_APP_PRIVATE_KEY: appKeyPem });
		expect((await postToken(env, "{}")).status).toBe(401);
		expect((await postToken(env, "{}", "Basic abc")).status).toBe(401);
		// Length mismatch short-circuits; same-length diff compares bytes.
		expect((await postToken(env, "{}", "Bearer short")).status).toBe(401);
		expect((await postToken(env, "{}", "Bearer mint-secreX")).status).toBe(401);
	});

	it("rejects everything when TOKEN_MINT_SECRET is unset", async () => {
		const env = makeEnv({ GITHUB_APP_ID: "x" });
		expect((await postToken(env, "{}", "Bearer mint-secret")).status).toBe(401);
	});

	it("503s when the GitHub App is not fully configured", async () => {
		const env = { TOKEN_MINT_SECRET: "mint-secret" };
		for (const e of [
			makeEnv(env),
			makeEnv({ ...env, GITHUB_APP_ID: "1" }),
			makeEnv({ ...env, GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" }),
		]) {
			const res = await postToken(e, "{}", "Bearer mint-secret");
			expect(res.status).toBe(503);
		}
	});

	it("mints a token for the installation default scope (no/invalid body)", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = tokenEnv({ GITHUB_APP_PRIVATE_KEY: appKeyPem });

		for (const body of [undefined, "{not json"]) {
			const res = await postToken(env, body, "Bearer mint-secret");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				token: "ghs_x",
				expires_at: "2030-01-01T00:00:00Z",
			});
		}
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/app/installations/5678/access_tokens",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "application/vnd.github+json",
					"User-Agent": "lasius-ci-hook",
					Authorization: expect.stringMatching(/^Bearer eyJ/),
				}),
				body: "{}",
			}),
		);
	});

	it("narrows scope to allowlisted repositories — exact and basename match", async () => {
		const fetchMock = vi.fn(async () => Response.json({ token: "t", expires_at: "e" }));
		vi.stubGlobal("fetch", fetchMock);
		const env = tokenEnv({
			GITHUB_APP_PRIVATE_KEY: appKeyPem,
			TOKEN_ALLOWED_REPOS: "docs, website",
		});

		for (const repos of [["docs"], ["ktbhealth/website"]]) {
			const res = await postToken(
				env,
				JSON.stringify({ repositories: repos }),
				"Bearer mint-secret",
			);
			expect(res.status).toBe(200);
		}
		expect(fetchMock).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ repositories: ["ktbhealth/website"] }),
			}),
		);
	});

	it("403s repositories outside the allowlist and skips checks without one", async () => {
		const fetchMock = vi.fn(async () => Response.json({ token: "t", expires_at: "e" }));
		vi.stubGlobal("fetch", fetchMock);
		const env = tokenEnv({
			GITHUB_APP_PRIVATE_KEY: appKeyPem,
			TOKEN_ALLOWED_REPOS: "docs",
		});
		const denied = await postToken(
			env,
			JSON.stringify({ repositories: ["docs", "evil/repo"] }),
			"Bearer mint-secret",
		);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: "repos not allowed: evil/repo" });

		// No allowlist configured → any repo set goes through unchecked.
		const open = tokenEnv({ GITHUB_APP_PRIVATE_KEY: appKeyPem });
		const res = await postToken(
			open,
			JSON.stringify({ repositories: ["anything"] }),
			"Bearer mint-secret",
		);
		expect(res.status).toBe(200);
	});

	it("400s a present-but-malformed repositories field, tolerates non-object JSON", async () => {
		const fetchMock = vi.fn(async () => Response.json({ token: "t", expires_at: "e" }));
		vi.stubGlobal("fetch", fetchMock);
		const env = tokenEnv({
			GITHUB_APP_PRIVATE_KEY: appKeyPem,
			TOKEN_ALLOWED_REPOS: "docs",
		});

		for (const body of [
			JSON.stringify({ repositories: "docs" }),
			JSON.stringify({ repositories: ["docs", 42] }),
		]) {
			const res = await postToken(env, body, "Bearer mint-secret");
			expect(res.status).toBe(400);
		}
		expect(fetchMock).not.toHaveBeenCalled();

		// Literal `null` / scalar bodies carry no repositories field —
		// installation default scope, same as an empty body.
		for (const body of ["null", "5", '"docs"']) {
			const res = await postToken(env, body, "Bearer mint-secret");
			expect(res.status).toBe(200);
		}
	});

	it("502s with the trimmed detail when GitHub rejects the mint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("x".repeat(400), { status: 422 })),
		);
		const res = await postToken(
			tokenEnv({ GITHUB_APP_PRIVATE_KEY: appKeyPem }),
			JSON.stringify({ repositories: ["docs"] }),
			"Bearer mint-secret",
		);
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string; detail: string };
		expect(body.error).toBe("github 422");
		expect(body.detail).toHaveLength(300);
	});
});

describe("repository events → repo-policy dispatch", () => {
	let appKeyPem: string;

	const repoEnv = (overrides: Partial<Env> = {}): Env =>
		makeEnv({
			GITHUB_APP_ID: "1234",
			GITHUB_APP_INSTALLATION_ID: "5678",
			GITHUB_APP_PRIVATE_KEY: appKeyPem,
			...overrides,
		});

	const repoEvent = (overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			action: "created",
			repository: { full_name: "ktbhealth/newrepo" },
			sender: { login: "luis" },
			...overrides,
		});

	// access_tokens mint then dispatches — the happy-path call order.
	const githubOk = () =>
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/access_tokens")) {
				return Response.json({ token: "ghs_ws", expires_at: "2030-01-01T00:00:00Z" });
			}
			return new Response(null, { status: 204 });
		});

	beforeAll(async () => {
		const { privateKey } = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign"],
		)) as CryptoKeyPair;
		const der = (await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer;
		const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
		const lines = b64.match(/.{1,64}/g) ?? [b64];
		appKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
	});

	afterEach(() => vi.unstubAllGlobals());

	it("mints a workspace-scoped token then dispatches repo-policy", async () => {
		const fetchMock = githubOk();
		vi.stubGlobal("fetch", fetchMock);
		const env = repoEnv();
		const res = await post(repoEvent(), "repository", undefined, env);
		expect(res.status).toBe(200);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://api.github.com/app/installations/5678/access_tokens",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: expect.stringMatching(/^Bearer eyJ/),
				}),
				body: JSON.stringify({ repositories: ["workspace"] }),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://api.github.com/repos/ktbhealth/workspace/dispatches",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer ghs_ws",
					Accept: "application/vnd.github+json",
					"User-Agent": "lasius-ci-hook",
					"X-GitHub-Api-Version": "2022-11-28",
				}),
				body: JSON.stringify({
					event_type: "repo-policy",
					client_payload: {
						repo: "ktbhealth/newrepo",
						action: "created",
						sender: "luis",
					},
				}),
			}),
		);
	});

	it("dispatches for publicized and renamed too", async () => {
		const fetchMock = githubOk();
		vi.stubGlobal("fetch", fetchMock);
		const env = repoEnv();
		for (const action of ["publicized", "renamed"]) {
			const res = await post(repoEvent({ action }), "repository", undefined, env);
			expect(res.status).toBe(200);
		}
		// 2 events × (token mint + dispatch)
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("ignores repository actions outside the policy set and missing fields", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = repoEnv();
		for (const payload of [
			repoEvent({ action: "deleted" }),
			repoEvent({ action: "archived" }),
			repoEvent({ action: undefined }),
			JSON.stringify({}), // no action at all
		]) {
			const res = await post(payload, "repository", undefined, env);
			expect(res.status).toBe(200);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to ? for missing repo and sender fields", async () => {
		const fetchMock = githubOk();
		vi.stubGlobal("fetch", fetchMock);
		const env = repoEnv();
		const res = await post(repoEvent({ repository: {}, sender: {} }), "repository", undefined, env);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://api.github.com/repos/ktbhealth/workspace/dispatches",
			expect.objectContaining({
				body: JSON.stringify({
					event_type: "repo-policy",
					client_payload: { repo: "?", action: "created", sender: "?" },
				}),
			}),
		);
	});

	it("acks without dispatching when app creds are missing", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const env of [
			makeEnv(),
			makeEnv({ GITHUB_APP_ID: "1" }),
			makeEnv({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" }),
		]) {
			const res = await post(repoEvent(), "repository", undefined, env);
			expect(res.status).toBe(200);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still 200s when the token mint fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		);
		const res = await post(repoEvent(), "repository", undefined, repoEnv());
		expect(res.status).toBe(200);
	});

	it("still 200s when the mint returns no token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ expires_at: "e" })),
		);
		const res = await post(repoEvent(), "repository", undefined, repoEnv());
		expect(res.status).toBe(200);
	});

	it("still 200s when the dispatch API fails", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/access_tokens")) {
				return Response.json({ token: "ghs_ws", expires_at: "2030-01-01T00:00:00Z" });
			}
			return new Response("forbidden", { status: 403 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const env = repoEnv({
			NTFY_URL: "https://ntfy.example",
			NTFY_TOPIC: "ci",
		});
		const res = await post(repoEvent(), "repository", undefined, env);
		expect(res.status).toBe(200);
		// Failure surfaced via ntfy as a third fetch.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://ntfy.example/ci",
			expect.objectContaining({
				headers: expect.objectContaining({
					Title: "repo-policy dispatch failed: ktbhealth/newrepo",
				}),
			}),
		);
	});
});
