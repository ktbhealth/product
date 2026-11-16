import { Effect } from "effect";

import { Captcha } from "@ktb/captcha";
import { createPluginApiRoute, getServerRuntime, run } from "@ktb/server-fns";

/** better-auth paths that need a bot check: they accept raw credentials
 * or make the server send email to a caller-supplied address. */
const CREDENTIAL_PATHS = ["/sign-in/email", "/sign-up/email", "/send-verification-email"];

/**
 * The better-auth apiKey plugin mounts session-authenticated
 * `/api/auth/api-key/*` routes (list/get/create/update/delete/verify).
 * Those responses carry the apikey row's `metadata` — where our managed
 * eval-lab credentials keep the outbound secret — to ANY session
 * holder, and create/update accept arbitrary metadata. Nothing calls
 * them over HTTP (all key access is server-side via `auth.api`), so the
 * whole subtree 404s BEFORE `auth.handler` sees the request.
 */
const isApiKeyPath = (pathname: string) => pathname.startsWith("/api/auth/api-key");

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/**
 * Dispatch one request to the credential provider's catch-all handler.
 * The better-auth instance is composed by the host (apps/web keeps it
 * out of the driver registry on purpose — see @ktb/app-host) and
 * reaches this plugin through the `authHandler` server-runtime
 * capability; plugins never import the adapter.
 */
const handleAuthRequest = (request: Request): Promise<Response> => {
	const handler = getServerRuntime().authHandler;
	if (handler === undefined) {
		return Promise.resolve(new Response("auth handler unavailable", { status: 500 }));
	}
	return handler(request);
};

/**
 * better-auth catch-all: /api/auth/* (sign-in, sign-up, session,
 * sign-out). Moved from apps/web/src/routes/api/auth.$.ts (P-062) —
 * mounted into the host's virtual route tree by `authRoutesPlugin`
 * (physical("/api", "src/api-routes")); the session/runtime boundary
 * is @ktb/server-fns, so no host imports are needed.
 *
 * Credential posts (/sign-in/email, /sign-up/email) pass the Captcha
 * bot check first: the verifier comes from the composed runtime via
 * `run` (CaptchaLive is part of the app core layer), resolves null
 * when bot checks are disabled, and fails closed on bad tokens.
 */
export const Route = createPluginApiRoute("auth.routes")("/api/auth/$")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const { pathname } = new URL(request.url);
				if (isApiKeyPath(pathname)) return notFound();
				return handleAuthRequest(request);
			},
			POST: async ({ request }) => {
				const { pathname } = new URL(request.url);
				if (isApiKeyPath(pathname)) return notFound();
				const captcha = await run(Effect.service(Captcha));
				if (captcha && CREDENTIAL_PATHS.some((p) => pathname.endsWith(p))) {
					const body = (await request
						.clone()
						.json()
						.catch(() => null)) as { captchaToken?: string } | null;
					const remoteIp = request.headers.get("cf-connecting-ip") ?? undefined;
					const ok = await captcha.verify(body?.captchaToken, remoteIp);
					if (!ok) {
						return Response.json(
							{
								code: "CAPTCHA_FAILED",
								message: "Security verification failed. Please try again.",
							},
							{ status: 403 },
						);
					}
				}
				return handleAuthRequest(request);
			},
		},
	},
});
