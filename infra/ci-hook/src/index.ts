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
}

const encoder = new TextEncoder();

async function verifySignature(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	// Constant-time-ish compare: lengths equal + every byte compared.
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

async function notifyNtfy(env: Env, title: string, body: string, priority: "low" | "default" | "high"): Promise<void> {
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
	if (payload.action !== "completed" || !run?.conclusion || run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral") {
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
		if (request.method !== "POST" || url.pathname !== "/") {
			return new Response("not found", { status: 404 });
		}

		const body = await request.text();
		const ok = await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256"));
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
