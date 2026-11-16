import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CommandBus, QueryBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { makeD1 } from "@ktb/db/testing";
import { PluginStates } from "@ktb/platform/plugin-states";
import { AI_ENDPOINTS_TEST_DDL } from "../../../plugins/ai-endpoints/src/index.ts";
import {
	NotificationsMarkAllRead,
	NotificationsUnreadCount,
} from "../../../plugins/notifications/src/api.ts";
import * as Effect from "effect/Effect";

import {
	assertAuthConfigured,
	assertCaptchaConfigured,
	createApp,
	defaultVerificationEmail,
	isProductionBuild,
	plugins,
} from "./index.ts";

const DDL = `
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, payload TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE plugin_state (plugin_id TEXT PRIMARY KEY NOT NULL, enabled INTEGER DEFAULT true NOT NULL, config TEXT, updated_at INTEGER NOT NULL);
${AI_ENDPOINTS_TEST_DDL}
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
			await expect(app.correctTranscript("   ")).resolves.toBeNull();
		});

		it("corrects through the configured Workers AI binding", async () => {
			await expect(app.correctTranscript("texto cru")).resolves.toMatchObject({
				corrected: "Texto corrigido.",
				engine: expect.stringContaining("workers-ai"),
			});
		});

		it("prefers the platform-default endpoint over env providers (F2)", async () => {
			// Seed a platform-scope default endpoint — the host binds
			// LlmFactory via the always-eligible driver, so the row resolves
			// to a chat layer; stub fetch so the chat completion succeeds.
			await env.DB.prepare(
				"INSERT INTO ai_endpoint (name, kind, base_url, model, scope, is_default, created_at) VALUES ('t', 'openai', 'https://llm.test', 'm', 'platform', 1, 0)",
			).run();
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({ choices: [{ message: { content: "  Texto corrigido.  " } }] }),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
			try {
				await expect(app.correctTranscript("texto cru")).resolves.toMatchObject({
					corrected: "Texto corrigido.",
					engine: expect.stringContaining("platform:"),
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
