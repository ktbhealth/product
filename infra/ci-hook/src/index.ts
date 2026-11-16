// ci.ktbhealth.workers.dev — GitHub org webhook receiver.
//
// One org-level webhook (ktbhealth/.github → this worker) delivers
// push / pull_request / workflow_run events for every repo in the org.
// The worker verifies X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET
// and, on failed workflow runs, pushes a notification to ntfy.
// Everything else is acknowledged and dropped — this is a signal
// collector, not a CI orchestrator (that's peregrin's job, T-026).

export interface Env {
	GITHUB_WEBHOOK_SECRET: string;
	NTFY_URL?: string;
	NTFY_TOPIC?: string;
	/** Full Authorization header value (e.g. "Bearer tk_…"). */
	NTFY_AUTH?: string;
	/** ntfy access token — sent as `Authorization: Bearer <token>`. */
	NTFY_AUTH_TOKEN?: string;
	/** GitHub App (lasius-bot) credentials for POST /token. */
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	/** PEM private key (PKCS#8) for the app. */
	GITHUB_APP_PRIVATE_KEY?: string;
	/** Bearer secret guarding POST /token. */
	TOKEN_MINT_SECRET?: string;
	/** Comma-separated allowlist of "owner/repo" (or bare repo names)
	 *  the broker will mint tokens for. Empty = installation default. */
	TOKEN_ALLOWED_REPOS?: string;
}

const encoder = new TextEncoder();

async function verifySignature(
	secret: string,
	body: string,
	signature: string | null,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected =
		"sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	// Constant-time-ish compare: lengths equal + every byte compared.
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

async function notifyNtfy(
	env: Env,
	title: string,
	body: string,
	priority: "low" | "default" | "high",
): Promise<void> {
	if (!env.NTFY_URL || !env.NTFY_TOPIC) return;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Title: title,
		Priority: priority,
	};
	if (env.NTFY_AUTH) headers.Authorization = env.NTFY_AUTH;
	else if (env.NTFY_AUTH_TOKEN) headers.Authorization = `Bearer ${env.NTFY_AUTH_TOKEN}`;
	await fetch(`${env.NTFY_URL}/${env.NTFY_TOPIC}`, {
		method: "POST",
		headers,
		body,
	});
}

// --- POST /token: mint GitHub App installation tokens -----------------
//
// lasius-bot is installed on a narrow repo set; this route returns a
// fresh ~1h token so CI never stores long-lived credentials. Callers
// authenticate with TOKEN_MINT_SECRET and may narrow scope via
// {"repositories": ["docs"]}.

function base64url(data: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pemToDer(pem: string): Uint8Array {
	const b64 = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function appJwt(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: env.GITHUB_APP_ID }));
	const unsigned = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(env.GITHUB_APP_PRIVATE_KEY ?? "") as BufferSource,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
	return `${unsigned}.${base64url(sig)}`;
}

function secretsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

async function handleTokenMint(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!env.TOKEN_MINT_SECRET || !secretsEqual(token, env.TOKEN_MINT_SECRET)) {
		return new Response("unauthorized", { status: 401 });
	}
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) {
		return Response.json({ error: "app not configured" }, { status: 503 });
	}

	let repositories: string[] | undefined;
	try {
		const body = (await request.json()) as { repositories?: string[] };
		repositories = body.repositories;
	} catch {
		// empty body is fine — installation default scope
	}

	const allowlist = (env.TOKEN_ALLOWED_REPOS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (allowlist.length && repositories?.length) {
		const denied = repositories.filter(
			(r) => !allowlist.some((a) => a === r || a === r.split("/").pop()),
		);
		if (denied.length) {
			return Response.json({ error: `repos not allowed: ${denied.join(", ")}` }, { status: 403 });
		}
	}

	const jwt = await appJwt(env);
	const res = await fetch(
		`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "lasius-ci-hook",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(repositories?.length ? { repositories } : {}),
		},
	);
	if (!res.ok) {
		const detail = await res.text();
		return Response.json({ error: `github ${res.status}`, detail: detail.slice(0, 300) }, { status: 502 });
	}
	const data = (await res.json()) as { token?: string; expires_at?: string };
	return Response.json({ token: data.token, expires_at: data.expires_at });
}

interface WorkflowRunPayload {
	action?: string;
	repository?: { full_name?: string };
	workflow_run?: {
		name?: string;
		conclusion?: string | null;
		html_url?: string;
		head_branch?: string;
	};
}

async function handleWorkflowRun(env: Env, payload: WorkflowRunPayload): Promise<void> {
	const run = payload.workflow_run;
	if (
		payload.action !== "completed" ||
		!run?.conclusion ||
		run.conclusion === "success" ||
		run.conclusion === "skipped" ||
		run.conclusion === "neutral"
	) {
		return;
	}
	const repo = payload.repository?.full_name ?? "?";
	await notifyNtfy(
		env,
		`CI ${run.conclusion}: ${repo}`,
		`${run.name ?? "workflow"} on ${run.head_branch ?? "?"} — ${run.html_url ?? ""}`,
		run.conclusion === "failure" ? "high" : "default",
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true, service: "ci-hook" });
		}
		if (request.method === "POST" && url.pathname === "/token") {
			return handleTokenMint(request, env);
		}
		if (request.method !== "POST" || url.pathname !== "/") {
			return new Response("not found", { status: 404 });
		}

		const body = await request.text();
		const ok = await verifySignature(
			env.GITHUB_WEBHOOK_SECRET,
			body,
			request.headers.get("X-Hub-Signature-256"),
		);
		if (!ok) return new Response("bad signature", { status: 401 });

		const event = request.headers.get("X-GitHub-Event") ?? "";
		if (event === "ping") {
			return Response.json({ ok: true });
		}

		try {
			const payload = JSON.parse(body);
			if (event === "workflow_run") {
				await handleWorkflowRun(env, payload as WorkflowRunPayload);
			}
			// push / pull_request / everything else: acknowledged, logged
			// via workers observability. Extend here when peregrin lands.
		} catch {
			return new Response("bad payload", { status: 400 });
		}
		return Response.json({ ok: true });
	},
} satisfies ExportedHandler<Env>;
