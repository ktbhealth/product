import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Calendars, type CalendarCredentials } from "@ktb/calendar";
import { Principal } from "@ktb/authz";
import {
	installServerFnRuntime,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { CalendarIntegrations } from "./calendar.ts";
import { Route as CallbackRoute } from "./api-routes/calendar.google.callback.ts";
import {
	CALENDAR_OAUTH_STATE_COOKIE,
	Route as ConnectRoute,
} from "./api-routes/calendar.google.connect.ts";

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

let oauthConfigured = true;
let exchangeCalls: string[];
let completeCalls: string[];
let principalSeen: string | null;

const integrationsStub = CalendarIntegrations.of({
	connection: () => Effect.succeed(null),
	completeOAuth: (ownerId, input) =>
		Effect.gen(function* () {
			const principal = yield* Principal;
			principalSeen = principal?.userId ?? null;
			completeCalls.push(`${ownerId}:${input.provider}:${input.calendarId ?? "primary"}`);
			return {
				id: 1,
				provider: input.provider,
				calendarId: input.calendarId ?? "primary",
				status: "active",
				lastSyncAt: null,
			};
		}),
	importEvents: () => Effect.die(new Error("unused")),
});

const calendarsStub = Calendars.of({
	provider: (id) =>
		id !== "google"
			? undefined
			: {
					id: "google",
					...(oauthConfigured
						? {
								oauth: {
									authorizationUrl: ({ state }) => `https://oauth.example/auth?state=${state}`,
									exchangeCode: async (code): Promise<CalendarCredentials> => {
										exchangeCalls.push(code);
										return { accessToken: "access", refreshToken: "refresh" };
									},
									refresh: async (credentials) => credentials,
								},
							}
						: {}),
					connect: async () => {
						throw new Error("unused");
					},
				},
	providers: () => ["google"],
});

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Calendars, calendarsStub),
		Layer.succeed(CalendarIntegrations, integrationsStub),
	) as Layer.Layer<unknown, never, never>,
);

installServerFnRuntime(
	runtime,
	stubAuth(() => sessionUser("doc@example.com")),
);

afterAll(() => {
	resetServerFnRuntime();
});

beforeEach(() => {
	oauthConfigured = true;
	exchangeCalls = [];
	completeCalls = [];
	principalSeen = null;
});

const connect = async () => {
	const res = await handlersOf(ConnectRoute).GET!({
		request: new Request("http://x/api/calendar/google/connect"),
	} as never);
	expect(res.status).toBe(302);
	const location = res.headers.get("location");
	expect(location).toContain("https://oauth.example/auth");
	const state = new URL(location!).searchParams.get("state");
	expect(state).toBeTruthy();
	return state!;
};

describe("google calendar oauth routes", () => {
	it("connect redirects a doctor to the provider with a signed state cookie", async () => {
		const state = await connect();
		expect(state).toMatch(/^[a-f0-9]{48}\..+/);
	});

	it("redirects to an unavailable error when oauth client config is absent", async () => {
		oauthConfigured = false;
		const res = await handlersOf(ConnectRoute).GET!({
			request: new Request("http://x/api/calendar/google/connect"),
		} as never);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			"/portal/doctor/agenda?calendarImport=calendar-unavailable",
		);
	});

	it("callback completes oauth as the doctor principal, not system context", async () => {
		const state = await connect();
		const res = await handlersOf(CallbackRoute).GET!({
			request: new Request(`http://x/api/calendar/google/callback?state=${state}&code=code-1`, {
				headers: { cookie: `${CALENDAR_OAUTH_STATE_COOKIE}=${state}` },
			}),
		} as never);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/portal/doctor/agenda?calendarImport=connected");
		expect(exchangeCalls).toEqual(["code-1"]);
		expect(completeCalls).toEqual(["id-doc@example.com:google:primary"]);
		expect(principalSeen).toBe("id-doc@example.com");
	});

	it("rejects a callback whose state cookie does not match", async () => {
		const state = await connect();
		const res = await handlersOf(CallbackRoute).GET!({
			request: new Request(`http://x/api/calendar/google/callback?state=${state}&code=code-1`, {
				headers: { cookie: `${CALENDAR_OAUTH_STATE_COOKIE}=forged` },
			}),
		} as never);
		expect(res.headers.get("location")).toBe("/portal/doctor/agenda?calendarImport=invalid-state");
		expect(exchangeCalls).toEqual([]);
		expect(completeCalls).toEqual([]);
	});
});
