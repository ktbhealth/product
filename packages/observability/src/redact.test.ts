import { describe, expect, it, vi, afterEach } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
	consoleJsonLogger,
	isSensitiveKey,
	redactLogRecord,
	redactString,
	redactValue,
} from "./redact.ts";

describe("redactValue", () => {
	it("redacts sensitive keys case-insensitively", () => {
		expect(
			redactValue({
				password: "hunter2",
				Authorization: "Bearer x",
				api_key: "k",
				ACCESS_TOKEN: "t",
				cookie: "c=1",
				safe: "value",
			}),
		).toEqual({
			password: "[redacted]",
			Authorization: "[redacted]",
			api_key: "[redacted]",
			ACCESS_TOKEN: "[redacted]",
			cookie: "[redacted]",
			safe: "value",
		});
	});

	it("recurses through nested objects and arrays", () => {
		expect(
			redactValue({
				outer: { inner: { secret: "s", ok: 1 } },
				list: [{ token: "t" }, { fine: true }],
			}),
		).toEqual({
			outer: { inner: { secret: "[redacted]", ok: 1 } },
			list: [{ token: "[redacted]" }, { fine: true }],
		});
	});

	it("passes primitives and non-plain objects through", () => {
		const date = new Date(0);
		expect(redactValue("str")).toBe("str");
		expect(redactValue(42)).toBe(42);
		expect(redactValue(null)).toBeNull();
		expect(redactValue(undefined)).toBeUndefined();
		expect(redactValue(date)).toBe(date);
	});

	it("redacts bare key/secret/token/password field names in nested objects", () => {
		expect(
			redactValue({
				config: { key: "k", secret: "s", token: "t", password: "p" },
				list: [{ apiKey: "a" }, { nested: { sessionToken: "st" } }],
			}),
		).toEqual({
			config: {
				key: "[redacted]",
				secret: "[redacted]",
				token: "[redacted]",
				password: "[redacted]",
			},
			list: [{ apiKey: "[redacted]" }, { nested: { sessionToken: "[redacted]" } }],
		});
	});

	it("matches sensitive words across camelCase, snake_case and kebab-case", () => {
		for (const key of [
			"apiKey",
			"API_KEY",
			"api-key",
			"accessToken",
			"client_secret",
			"refresh-token",
			"privateKey",
			"X-Api-Key",
		]) {
			expect(isSensitiveKey(key)).toBe(true);
		}
	});

	it("does not redact benign keys that merely contain sensitive substrings", () => {
		for (const key of [
			"keyboard",
			"monkey",
			"cardiac",
			"requestId",
			"traceId",
			"spanId",
			"handlerType",
			"author",
			"wildcard",
		]) {
			expect(isSensitiveKey(key)).toBe(false);
		}
	});

	it("redacts every word in the sensitive vocabulary", () => {
		// The vocabulary is the contract — dropping a word silently leaks
		// that class of secret to log sinks.
		for (const word of [
			"password",
			"passwords",
			"passwd",
			"passwds",
			"pwd",
			"secret",
			"secrets",
			"token",
			"tokens",
			"key",
			"keys",
			"apikey",
			"apikeys",
			"authorization",
			"auth",
			"oauth",
			"bearer",
			"jwt",
			"cookie",
			"cookies",
			"session",
			"sessions",
			"credential",
			"credentials",
			"ssn",
			"cpf",
			"card",
			"cards",
			"cvv",
			"otp",
			"pin",
		]) {
			expect(isSensitiveKey(word), word).toBe(true);
		}
	});

	it("splits keys on camelCase boundaries and separators", () => {
		expect(isSensitiveKey("apiKey")).toBe(true);
		expect(isSensitiveKey("requestId")).toBe(false);
		expect(isSensitiveKey("x-api_key")).toBe(true);
		expect(isSensitiveKey("API-KEY")).toBe(true);
		expect(isSensitiveKey("sessionId")).toBe(true);
		expect(isSensitiveKey("traceparent")).toBe(false);
	});

	it("scrubs secret shapes embedded in string values", () => {
		expect(redactValue({ note: "used Bearer abcdef1234567890 to call api" })).toEqual({
			note: "used Bearer [redacted] to call api",
		});
		expect(redactValue({ note: "Basic dXNlcjpwYXNzMTIzNDU=" })).toEqual({
			note: "Basic [redacted]",
		});
		expect(redactValue({ dsn: "postgres://app:s3cretpw@db.internal:5432/app" })).toEqual({
			dsn: "postgres://app:[redacted]@db.internal:5432/app",
		});
		expect(redactValue({ contact: "reach ana.souza+ktb@example.com.br please" })).toEqual({
			contact: "reach [redacted-email] please",
		});
	});

	it("scrubs JWTs in string values", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlfUP8THsR8U";
		expect(redactString(`token was ${jwt} ok`)).toBe("token was [redacted] ok");
	});

	it("requires at least 8 credential chars after the auth scheme", () => {
		expect(redactString("Bearer abcdefgh1234")).toBe("Bearer [redacted]");
		// Shorter payloads are not credential-shaped — left alone.
		expect(redactString("Bearer short")).toBe("Bearer short");
		// Multiple spaces between scheme and credential still redact
		// (the whitespace run collapses into the single replacement space).
		expect(redactString("Bearer  abcdefgh1234")).toBe("Bearer [redacted]");
		// Scheme match is case-insensitive.
		expect(redactString("bearer abcdefgh1234")).toBe("bearer [redacted]");
	});

	it("masks only the password in scheme://user:pass@host strings", () => {
		expect(redactString("mysql://root:hunter2@db.internal/app")).toBe(
			"mysql://root:[redacted]@db.internal/app",
		);
		// Schemes with digits/signs still match.
		expect(redactString("postgresql+psycopg://u:p%40ss@host/db")).toBe(
			"postgresql+psycopg://u:[redacted]@host/db",
		);
		// No userinfo → nothing to mask.
		expect(redactString("https://host/path")).toBe("https://host/path");
	});

	it("masks credentials for single-char and digit-terminated schemes", () => {
		// The pattern must match the FULL scheme, not a suffix tail: a
		// 1-char scheme has no tail to match, and a trailing digit can't
		// start the [a-zA-Z] class the weakened patterns look for.
		expect(redactString("x://user:secretpw@host/db")).toBe("x://user:[redacted]@host/db");
		expect(redactString("h2://user:secretpw@host/db")).toBe("h2://user:[redacted]@host/db");
	});

	it("redacts inside arrays and deep structures", () => {
		expect(redactValue([{ password: "p" }, ["Bearer abcdefgh1234"]])).toEqual([
			{ password: "[redacted]" },
			["Bearer [redacted]"],
		]);
	});

	it("treats null-prototype objects as plain and class instances as opaque", () => {
		const nullProto = Object.assign(Object.create(null), { apiKey: "k", ok: 1 });
		expect(redactValue(nullProto)).toEqual({ apiKey: "[redacted]", ok: 1 });
		class Box {
			readonly password = "p";
		}
		const box = new Box();
		expect(redactValue(box)).toBe(box);
	});
});

describe("redactLogRecord", () => {
	it("scrubs annotations and message payloads", () => {
		const record = {
			message: ["login failed"],
			annotations: { user: "u1", password: "p" },
		};
		const out = redactLogRecord(record);
		expect(out.annotations).toEqual({ user: "u1", password: "[redacted]" });
		expect(out.message).toEqual(["login failed"]);
	});
});

describe("consoleJsonLogger", () => {
	afterEach(() => vi.restoreAllMocks());

	it("emits single-line JSON with redacted annotations", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		Effect.runSync(
			Effect.logInfo("user login").pipe(
				Effect.annotateLogs({ username: "ana", password: "secret" }),
				Effect.provide(Logger.layer([consoleJsonLogger])),
			),
		);
		expect(spy).toHaveBeenCalledTimes(1);
		const line = spy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(line);
		expect(parsed.message).toBe("user login");
		expect(parsed.annotations.username).toBe("ana");
		expect(parsed.annotations.password).toBe("[redacted]");
		expect(parsed.level).toBe("INFO");
	});
});
