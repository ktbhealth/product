import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CommandBus, QueryBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { makeD1 } from "@ktb/db/testing";
import { Jobs } from "@ktb/jobs-port";
import { PluginStates } from "@ktb/platform/plugin-states";
import { PlatformAdmin } from "@ktb/platform";
import { pluginDuration, pluginInvocations, tagged } from "@ktb/observability";
import { AI_ENDPOINTS_TEST_DDL } from "../../../plugins/ai-provider/src/index.ts";
import {
	NotificationsMarkAllRead,
	NotificationsUnreadCount,
} from "../../../plugins/notifications/src/api.ts";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
	assertAuthConfigured,
	assertCaptchaConfigured,
	createApp,
	defaultPasswordResetEmail,
	defaultVerificationEmail,
	isProductionBuild,
	plugins,
} from "./index.ts";

const DDL = `
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, payload TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE plugin_state (plugin_id TEXT PRIMARY KEY NOT NULL, enabled INTEGER DEFAULT true NOT NULL, config TEXT, updated_at INTEGER NOT NULL);
${AI_ENDPOINTS_TEST_DDL}
`;

// job_runs projection for the Jobs-port test — same shape as
// packages/jobs-port/src/index.test.ts.
const JOB_RUNS_DDL = `
CREATE TABLE job_runs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued',
	payload_ref TEXT,
	error TEXT,
	tenant_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

// RBAC grant tables for the PlatformAdmin grantFor hook — same shape
// as plugins/rbac/src/index.test.ts (role_permissions/subject_roles
// were dropped in T-183; relation_tuples is the only grant store).
const RBAC_DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
`;

const env = {
	DB: makeD1(DDL),
	BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
	BETTER_AUTH_URL: "http://localhost:3000",
	PLATFORM_ADMIN_EMAILS: "admin@x.com",
	AI: { run: async () => ({ response: "  Texto corrigido.  " }) },
};

const app = createApp(env);

/** Structured log lines emitted through Logger.consoleJson. */
const logged = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("cqrs"));

afterAll(() => app.runtime.dispose());

afterEach(() => vi.restoreAllMocks());

describe("createApp", () => {
	it("discovers plugins in dependency order", () => {
		expect(app.plugins).toBe(plugins);
		expect(plugins.length).toBeGreaterThan(0);
	});

	it("discovers eval capability packs with their generic contributions (P-070)", () => {
		// Eval capability packs joined the registry when the negative
		// globs were removed: they carry eval.* entries on the
		// `contributions` channel — data the host never collects
		// (consumers opt in per kind), so discovery stays side-effect
		// free for them. Domain packs are NOT plugins (P-075):
		// eval.consult dissolved into evals/consultation and no longer
		// appears here.
		const byId = new Map(plugins.map((p) => [p.id, p]));
		for (const id of ["llm.eval", "storage.dataset", "transcription.asr", "transcription.tts"]) {
			expect(byId.has(id), id).toBe(true);
		}
		expect(byId.has("eval.consult")).toBe(false);
		expect(byId.get("transcription.tts")?.contributions?.length).toBeGreaterThan(0);
		// And they contribute nothing the host's surfaces consume.
		for (const id of ["llm.eval", "storage.dataset", "transcription.asr", "transcription.tts"]) {
			const p = byId.get(id);
			expect(p?.tables).toBeUndefined();
			expect(p?.services).toBeUndefined();
			expect(p?.routes).toBeUndefined();
			expect(p?.chrome).toBeUndefined();
			expect(p?.panel).toBeUndefined();
			expect(p?.pages).toBeUndefined();
			expect(p?.landing).toBeUndefined();
		}
	});

	it("run executes system-path effects without a principal", async () => {
		await expect(app.run(Effect.succeed("ok"))).resolves.toBe("ok");
	});

	it("flushTelemetry drains exporters without rejecting", async () => {
		await expect(app.flushTelemetry()).resolves.toBeUndefined();
	});

	it("logAccess emits http.access through the runtime logger set", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await app.logAccess({ method: "GET", path: "/x", status: 200, requestId: "r1" });
		const line = log.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.find((l: string) => l.includes("http.access"));
		expect(line).toBeDefined();
		// Fields land as log annotations — the same projection OTLP
		// exporters turn into log-record attributes.
		expect(JSON.parse(line!)).toMatchObject({
			message: "http.access",
			level: "INFO",
			annotations: { method: "GET", path: "/x", status: 200, requestId: "r1" },
		});
	});

	it("logAccess never rejects, even after the runtime is disposed", async () => {
		const disposed = createApp(env);
		await disposed.runtime.dispose();
		await expect(disposed.logAccess({ method: "GET" })).resolves.toBeUndefined();
	});

	it("logAccess emits inside a span when trace context fields are present", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await app.logAccess({
			method: "GET",
			path: "/x",
			status: 200,
			// Non-scalar whitelisted keys are skipped as span attributes.
			durationMs: { unexpected: true },
			requestId: "r1",
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});
		const line = log.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.find((l: string) => l.includes("http.access"));
		expect(line).toBeDefined();
		expect(JSON.parse(line!)).toMatchObject({ message: "http.access", level: "INFO" });
	});

	it("logAccess accepts a traceId + spanId pair without a raw traceparent", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await app.logAccess({
			method: "GET",
			path: "/x",
			status: 200,
			requestId: "r1",
			traceId: "0af7651916cd43dd8448eb211c80319c",
			spanId: "b7ad6b7169203331",
		});
		const line = log.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.find((l: string) => l.includes("http.access"));
		expect(line).toBeDefined();
	});

	it("logAccess ignores malformed trace context instead of failing", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await app.logAccess({
			method: "GET",
			path: "/x",
			status: 200,
			requestId: "r1",
			traceparent: "not-a-traceparent",
			traceId: "short",
			spanId: "b7ad6b7169203331",
		});
		const line = log.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.find((l: string) => l.includes("http.access"));
		expect(line).toBeDefined();
	});

	it("binds the Jobs port when AUDIO_QUEUE is configured", async () => {
		const send = vi.fn(async (_body: unknown) => {});
		const queueApp = createApp({
			...env,
			DB: makeD1(`${DDL}\n${JOB_RUNS_DDL}`),
			AUDIO_QUEUE: { send },
		});
		try {
			const envelope = await queueApp.run(
				Effect.flatMap(Jobs, (jobs) =>
					Effect.promise(() => jobs.enqueue("eval.run", { suite: "fx" })),
				),
			);
			expect(envelope.kind).toBe("eval.run");
			// The queue send lambda composed at the edge received the envelope.
			expect(send).toHaveBeenCalledWith(envelope);
		} finally {
			await queueApp.runtime.dispose();
		}
	});

	it("admits RBAC-granted admins through the PlatformAdmin gate", async () => {
		const rbacDb = makeD1(`${DDL}\n${RBAC_DDL}`);
		const rbacApp = createApp({ ...env, DB: rbacDb });
		try {
			const isAdmin = (subject: { email?: string | null; userId?: string | null }) =>
				rbacApp.run(Effect.flatMap(PlatformAdmin, (gate) => gate.isAdmin(subject)));
			// Allowlisted email short-circuits before any grant lookup.
			await expect(isAdmin({ email: "admin@x.com" })).resolves.toBe(true);
			// Unknown email + userId → the grantFor hook resolves grants:
			// no rows yet → deny.
			await expect(isAdmin({ email: "nobody@x.com", userId: "u1" })).resolves.toBe(false);
			// Seed an allow grant on (platform, admin) and bump the
			// permission epoch so the cached empty grant set re-resolves.
			await rbacApp.run(
				Effect.promise(async () => {
					// Explicit id 900: the rbac plugin's superadmin seed may
					// already own id 1 when its tables exist.
					await rbacDb
						.prepare(
							"INSERT INTO roles (id, name, created_at, updated_at) VALUES (900, 'it-admin', 0, 0)",
						)
						.run();
					// Resolution reads relation_tuples (the only grant
					// store since T-183): the grant tuple (role subject,
					// wildcard object) and the membership tuple (role
					// object, 'member' relation) are all that is needed —
					// the roles row above is metadata only.
					await rbacDb
						.prepare(
							"INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, created_at) VALUES ('platform', '*', 'admin', 'role', 'it-admin', 'allow', 0)",
						)
						.run();
					await rbacDb
						.prepare(
							"INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, created_at) VALUES ('role', 'it-admin', 'member', 'user', 'u1', 'allow', 0)",
						)
						.run();
					// Bump the epoch however the seed left it — the cached
					// empty grant set must re-resolve.
					await rbacDb
						.prepare(
							"INSERT INTO permission_epoch (id, epoch) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1",
						)
						.run();
				}),
			);
			await expect(isAdmin({ email: "nobody@x.com", userId: "u1" })).resolves.toBe(true);
			// No userId → no grant lookup, still denied.
			await expect(isAdmin({ email: "nobody@x.com" })).resolves.toBe(false);
		} finally {
			await rbacApp.runtime.dispose();
		}
	});

	it("run accepts a telemetry seed with route and traceparent", async () => {
		await expect(
			app.run(Effect.succeed("ok"), {
				requestId: "r-seed",
				route: "/patients",
				traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			}),
		).resolves.toBe("ok");
	});

	it("binds an app-supplied tenant resolver into runAs", async () => {
		const seen: unknown[] = [];
		const tenantApp = createApp(env, {
			tenantResolver: {
				resolve: (selector) => {
					seen.push(selector);
					return Effect.succeed(null);
				},
			},
		});
		try {
			await expect(
				tenantApp.runAs({ id: "u1" }, Effect.succeed("ok"), { slug: "clinic-a" }),
			).resolves.toBe("ok");
			expect(seen).toEqual([{ slug: "clinic-a" }]);
		} finally {
			await tenantApp.runtime.dispose();
		}
	});

	describe("assertCaptchaConfigured", () => {
		it("throws in production when no captcha driver is configured", () => {
			expect(() => assertCaptchaConfigured({}, true)).toThrow(/captcha not configured/);
		});

		it("allows production with Turnstile or the dev stub", () => {
			expect(() => assertCaptchaConfigured({ TURNSTILE_SECRET_KEY: "k" }, true)).not.toThrow();
			expect(() => assertCaptchaConfigured({ CAPTCHA_STUB: "1" }, true)).not.toThrow();
		});

		it("allows dev/test without any captcha env", () => {
			expect(() => assertCaptchaConfigured({}, false)).not.toThrow();
		});
	});

	describe("assertAuthConfigured", () => {
		const configured = {
			BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
			BETTER_AUTH_URL: "http://localhost:3000",
		};

		it("throws in production when the secret is missing", () => {
			expect(() =>
				assertAuthConfigured({ BETTER_AUTH_URL: configured.BETTER_AUTH_URL }, true),
			).toThrow(/auth not configured/);
		});

		it("throws in production when the base URL is missing", () => {
			expect(() =>
				assertAuthConfigured({ BETTER_AUTH_SECRET: configured.BETTER_AUTH_SECRET }, true),
			).toThrow(/auth not configured/);
		});

		it("allows production with both auth vars set", () => {
			expect(() => assertAuthConfigured(configured, true)).not.toThrow();
		});

		it("allows dev/test without any auth env", () => {
			expect(() => assertAuthConfigured({}, false)).not.toThrow();
		});
	});

	describe("isProductionBuild", () => {
		it("reads PROD from import.meta.env", () => {
			expect(isProductionBuild({ PROD: true })).toBe(true);
			expect(isProductionBuild({ PROD: false })).toBe(false);
		});

		it("treats a missing import.meta.env as non-production", () => {
			expect(isProductionBuild(undefined)).toBe(false);
		});
	});

	it("the Auth port resolves anonymous headers to no session", async () => {
		const session = await app.run(
			Effect.flatMap(Auth, (auth) => Effect.promise(() => auth.getSession(new Headers()))),
		);
		expect(session).toBeNull();
	});

	describe("CQRS bus middleware", () => {
		let log: ReturnType<typeof vi.spyOn>;

		const user = { id: "u1", email: "u1@x.com" };

		it("passes queries through at debug level", async () => {
			log = vi.spyOn(console, "log").mockImplementation(() => {});
			const count = await app.runAs(
				user,
				Effect.flatMap(QueryBus, (bus) => bus.execute(NotificationsUnreadCount, { userId: "u1" })),
			);
			expect(count).toBe(0);
			// Debug sits below the default Info log level: the query goes through the
			// middleware but emits neither a command log nor a failure warning.
			expect(logged(log)).toEqual([]);
		});

		it("logs successful commands at info", async () => {
			log = vi.spyOn(console, "log").mockImplementation(() => {});
			await app.runAs(
				user,
				Effect.flatMap(CommandBus, (bus) =>
					bus.execute(NotificationsMarkAllRead, { userId: "u1" }),
				),
			);
			expect(logged(log).some((l: string) => l.includes("cqrs command"))).toBe(true);
		});

		it("logs failed dispatches at warning and keeps the typed error", async () => {
			log = vi.spyOn(console, "log").mockImplementation(() => {});
			const exit = await app.runAs(
				user,
				Effect.flatMap(CommandBus, (bus) =>
					// u1 is bound, but the command targets another user's notifications.
					bus.execute(NotificationsMarkAllRead, { userId: "someone-else" }),
				).pipe(Effect.flip),
			);
			expect(exit).toMatchObject({ _tag: "Forbidden" });
			expect(logged(log).some((l: string) => l.includes("cqrs dispatch failed"))).toBe(true);
		});
	});

	describe("plugin SLO metrics", () => {
		const user = { id: "u1", email: "u1@x.com" };
		// The metric registry is process-wide, so earlier tests in this
		// file already contributed counts — assert deltas, not absolutes.
		const metricCount = <A, S>(metric: Metric.Metric<A, S>) =>
			Effect.runPromise(Metric.value(metric)).then((state) => {
				const count = (state as { count?: number | bigint }).count;
				return typeof count === "bigint" ? Number(count) : (count ?? 0);
			});
		const invocations = (side: "command" | "query", outcome: string) =>
			metricCount(tagged(pluginInvocations, { plugin: "notifications", side, outcome }));
		const durationCount = (side: "command" | "query") =>
			metricCount(tagged(pluginDuration, { plugin: "notifications", side }));
		const unread = () =>
			app.runAs(
				user,
				Effect.flatMap(QueryBus, (bus) => bus.execute(NotificationsUnreadCount, { userId: "u1" })),
			);
		const markAllRead = (userId: string) =>
			app.runAs(
				user,
				Effect.flatMap(CommandBus, (bus) => bus.execute(NotificationsMarkAllRead, { userId })),
			);
		const notificationsIds = plugins.filter((p) => p.pkg === "notifications").map((p) => p.id);
		const setEnabled = (enabled: boolean) =>
			app.run(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(notificationsIds, enabled);
				}),
			);

		it("counts a successful query as outcome=success and records duration", async () => {
			const [before, durationBefore] = await Promise.all([
				invocations("query", "success"),
				durationCount("query"),
			]);
			await expect(unread()).resolves.toBe(0);
			expect(await invocations("query", "success")).toBe(before + 1);
			expect(await durationCount("query")).toBe(durationBefore + 1);
		});

		it("counts a handler failure as outcome=error on the command side", async () => {
			const before = await invocations("command", "error");
			const exit = await markAllRead("someone-else").then(
				() => null,
				(e: unknown) => e,
			);
			expect(exit).toMatchObject({ _tag: "Forbidden" });
			expect(await invocations("command", "error")).toBe(before + 1);
		});

		it("counts a gate-blocked dispatch as outcome=disabled, not error", async () => {
			await setEnabled(false);
			try {
				const [disabledBefore, errorBefore, successBefore] = await Promise.all([
					invocations("query", "disabled"),
					invocations("query", "error"),
					invocations("query", "success"),
				]);
				const exit = await unread().then(
					() => null,
					(e: unknown) => e,
				);
				expect(exit).toMatchObject({ _tag: "PluginDisabled" });
				expect(await invocations("query", "disabled")).toBe(disabledBefore + 1);
				// Disabled traffic stays out of the success/error split.
				expect(await invocations("query", "error")).toBe(errorBefore);
				expect(await invocations("query", "success")).toBe(successBefore);
			} finally {
				await setEnabled(true);
			}
		});
	});

	describe("plugin enabled gate (P-058)", () => {
		const user = { id: "u1", email: "u1@x.com" };
		const unread = () =>
			app.runAs(
				user,
				Effect.flatMap(QueryBus, (bus) => bus.execute(NotificationsUnreadCount, { userId: "u1" })),
			);
		const setEnabled = (ids: readonly string[], enabled: boolean) =>
			app.run(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					yield* states.setEnabled(ids, enabled);
				}),
			);
		// Package membership comes from the `pkg` stamp, not the id —
		// the bare "notifications" marker id has no dot but is still a
		// package member, so disabling "the package" means every stamped
		// member, dotted ids included.
		const notificationsIds = plugins.filter((p) => p.pkg === "notifications").map((p) => p.id);

		it("blocks dispatch with PluginDisabled when every plugin of the package is off", async () => {
			expect(notificationsIds.length).toBeGreaterThan(1);
			await expect(unread()).resolves.toBe(0);
			await setEnabled(notificationsIds, false);
			try {
				const exit = await app
					.runAs(
						user,
						Effect.flatMap(QueryBus, (bus) =>
							bus.execute(NotificationsUnreadCount, { userId: "u1" }),
						).pipe(Effect.flip),
					)
					.catch((e: unknown) => e);
				expect(exit).toMatchObject({ _tag: "PluginDisabled", pluginId: "notifications" });
			} finally {
				await setEnabled(notificationsIds, true);
			}
			await expect(unread()).resolves.toBe(0);
		});

		it("keeps dispatch open while any plugin id of the package is enabled", async () => {
			// Disabling only the services plugin leaves the package's other
			// ids enabled — the package-level gate stays open.
			await setEnabled(["notifications.services"], false);
			try {
				await expect(unread()).resolves.toBe(0);
			} finally {
				await setEnabled(["notifications.services"], true);
			}
		});
	});

	describe("correctTranscript", () => {
		it("returns null for an empty transcript without calling the provider", async () => {
			await expect(app.correctTranscript({ text: "   " })).resolves.toBeNull();
		});

		it("corrects through env providers when no platform endpoint exists", async () => {
			// No ai_endpoint rows: the pack's env-cleanup stage resolves
			// the env LlmConfig (Workers AI binding) — the pipeline's own
			// configured fallback, not a caller-side chain.
			await expect(app.correctTranscript({ text: "texto cru" })).resolves.toMatchObject({
				corrected: "Texto corrigido.",
				engine: expect.stringContaining("workers-ai"),
			});
		});

		it("prefers the platform-default endpoint (reversible edits) over env providers", async () => {
			// Seed a platform-scope default endpoint — the pack's
			// llm-cleanup stage resolves it through PlatformLlm and the
			// corrector reply is a valid EditList, beating the env
			// Workers AI fallback entirely.
			await env.DB.prepare(
				"INSERT INTO ai_endpoint (name, kind, base_url, model, scope, is_default, created_at) VALUES ('t', 'openai', 'https://llm.test', 'm', 'platform', 1, 0)",
			).run();
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"ops":[]}' } }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
			try {
				await expect(app.correctTranscript({ text: "texto cru" })).resolves.toEqual({
					corrected: "texto cru",
					engine: "pipeline:openai-compat",
				});
			} finally {
				vi.unstubAllGlobals();
				await env.DB.prepare("DELETE FROM ai_endpoint").run();
			}
		});

		it("falls back to env providers inside the pipeline when the platform corrector fails", async () => {
			// Platform endpoint exists but its corrector reply is not an
			// EditList → llm-cleanup disables → env-cleanup answers.
			await env.DB.prepare(
				"INSERT INTO ai_endpoint (name, kind, base_url, model, scope, is_default, created_at) VALUES ('t', 'openai', 'https://llm.test', 'm', 'platform', 1, 0)",
			).run();
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: "not an edit list" } }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
			try {
				await expect(app.correctTranscript({ text: "texto cru" })).resolves.toMatchObject({
					corrected: "Texto corrigido.",
					engine: expect.stringContaining("workers-ai"),
				});
			} finally {
				vi.unstubAllGlobals();
				await env.DB.prepare("DELETE FROM ai_endpoint").run();
			}
		});
	});
});

describe("runAs principal", () => {
	const principal = (user: Parameters<typeof app.runAs>[0]) =>
		app.runAs(
			user,
			Effect.flatMap(Principal, (p) => Effect.succeed(p)),
		);

	it("binds the user as their own actor by default", async () => {
		expect(await principal({ id: "u1", email: "u1@x.com" })).toEqual({
			userId: "u1",
			email: "u1@x.com",
		});
		expect(await principal({ id: "u1", email: "u1@x.com", actorId: "u1" })).toEqual({
			userId: "u1",
			email: "u1@x.com",
		});
	});

	it("scopes to the doctor and records the actor under delegation", async () => {
		expect(await principal({ id: "doc", email: "sec@x.com", actorId: "sec" })).toEqual({
			userId: "doc",
			email: "sec@x.com",
			actorId: "sec",
		});
	});
});

describe("verification email", () => {
	const base = {
		BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
		BETTER_AUTH_URL: "http://localhost:3000",
	};
	const url = "http://localhost:3000/api/auth/verify-email?token=t";
	const verify = (target: ReturnType<typeof createApp>, name?: string) =>
		target.auth.options.emailVerification.sendVerificationEmail({
			user: { id: "u1", email: "a@ktb.test", name } as never,
			url,
			token: "t",
		});

	it("composes the default copy with and without a name", () => {
		const named = defaultVerificationEmail({ name: "Ana", url });
		expect(named.subject).toContain("KTB Health");
		expect(named.text).toContain("Hello, Ana.");
		expect(named.text).toContain(url);
		expect(defaultVerificationEmail({ name: null, url }).text).toMatch(/^Hello\.\n/);
	});

	it("is disabled when no email driver is configured", async () => {
		expect(app.auth.options.emailVerification.sendOnSignUp).toBe(false);
		await expect(verify(app)).resolves.toBeUndefined();
	});

	it("sends through the provider binding with the configured sender", async () => {
		const send = vi.fn<(builder: unknown) => Promise<unknown>>(async () => ({}));
		const withEmail = createApp({
			...base,
			DB: makeD1(DDL),
			EMAIL: { send },
			EMAIL_FROM: "noreply@ktb.test",
		});
		try {
			expect(withEmail.auth.options.emailVerification.sendOnSignUp).toBe(true);
			await verify(withEmail, "Ana");
			expect(send).toHaveBeenCalledWith({
				from: "noreply@ktb.test",
				to: "a@ktb.test",
				...defaultVerificationEmail({ name: "Ana", url }),
			});
		} finally {
			await withEmail.runtime.dispose();
		}
	});

	it("uses the app-supplied copy and survives a failed delivery", async () => {
		const failure = new Error("sender not verified");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const withEmail = createApp(
			{
				...base,
				DB: makeD1(DDL),
				EMAIL: { send: async () => Promise.reject(failure) },
				EMAIL_FROM: "noreply@ktb.test",
			},
			{ verificationEmail: ({ url: link }) => ({ subject: "Confirme", text: link }) },
		);
		try {
			await expect(verify(withEmail)).resolves.toBeUndefined();
			expect(errors).toHaveBeenCalledWith(
				"verification email failed",
				expect.objectContaining({ name: "EmailSendError", cause: failure }),
			);
		} finally {
			await withEmail.runtime.dispose();
		}
	});

	it("logs instead of sending under EMAIL_STUB", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const stubbed = createApp({ ...base, DB: makeD1(DDL), EMAIL_STUB: "1" });
		try {
			await verify(stubbed);
			expect(info).toHaveBeenCalledWith(expect.stringContaining("[email-stub] to=a@ktb.test"));
		} finally {
			await stubbed.runtime.dispose();
		}
	});
});

describe("password reset email", () => {
	const base = {
		BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
		BETTER_AUTH_URL: "http://localhost:3000",
	};
	const url = "http://localhost:3000/api/auth/reset-password/t?callbackURL=%2Freset-password";
	const request = (target: ReturnType<typeof createApp>, name?: string) =>
		target.auth.options.emailAndPassword?.sendResetPassword?.({
			user: { id: "u1", email: "a@ktb.test", name },
			url,
		} as never);

	it("composes the default copy with and without a name", () => {
		const named = defaultPasswordResetEmail({ name: "Ana", url });
		expect(named.subject).toContain("KTB Health");
		expect(named.text).toContain("Hello, Ana.");
		expect(named.text).toContain(url);
		expect(defaultPasswordResetEmail({ name: null, url }).text).toMatch(/^Hello\.\n/);
	});

	it("is disabled when no email driver is configured", () => {
		expect(app.auth.options.emailAndPassword?.sendResetPassword).toBeUndefined();
		expect(request(app)).toBeUndefined();
	});

	it("sends through the provider binding with the configured sender", async () => {
		const send = vi.fn<(builder: unknown) => Promise<unknown>>(async () => ({}));
		const withEmail = createApp({
			...base,
			DB: makeD1(DDL),
			EMAIL: { send },
			EMAIL_FROM: "noreply@ktb.test",
		});
		try {
			expect(withEmail.auth.options.emailAndPassword?.sendResetPassword).toBeDefined();
			await request(withEmail, "Ana");
			expect(send).toHaveBeenCalledWith({
				from: "noreply@ktb.test",
				to: "a@ktb.test",
				...defaultPasswordResetEmail({ name: "Ana", url }),
			});
		} finally {
			await withEmail.runtime.dispose();
		}
	});

	it("uses the app-supplied copy and survives a failed delivery", async () => {
		const failure = new Error("sender not verified");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const withEmail = createApp(
			{
				...base,
				DB: makeD1(DDL),
				EMAIL: { send: async () => Promise.reject(failure) },
				EMAIL_FROM: "noreply@ktb.test",
			},
			{ passwordResetEmail: ({ url: link }) => ({ subject: "Redefina", text: link }) },
		);
		try {
			await expect(request(withEmail)).resolves.toBeUndefined();
			expect(errors).toHaveBeenCalledWith(
				"password reset email failed",
				expect.objectContaining({ name: "EmailSendError", cause: failure }),
			);
		} finally {
			await withEmail.runtime.dispose();
		}
	});
});
