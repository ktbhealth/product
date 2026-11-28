import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import { Calendars, type ExternalEventDraft } from "@ktb/calendar";

import {
	exchangeGoogleOAuthCode,
	GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
	GOOGLE_CALENDARLIST_READONLY_SCOPE,
	GoogleCalendarApiError,
	googleAuthorizationUrl,
	googleCalendarsDriver,
	makeGoogleCalendarProvider,
	refreshGoogleAccessToken,
} from "./index.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const requestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const bodyText = (body: RequestInit["body"] | null | undefined): string =>
	typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";

const fetcher = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
	vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) =>
		handler(requestUrl(input), init),
	) as unknown as typeof fetch;

const event = {
	id: "evt-1",
	status: "confirmed",
	summary: "Consulta — J.S.",
	description: "apt-42",
	etag: '"etag"',
	updated: "2026-11-20T12:00:00.000Z",
	start: { dateTime: "2026-11-20T14:00:00.000Z" },
	end: { dateTime: "2026-11-20T14:30:00.000Z" },
};

describe("oauth helpers", () => {
	it("builds an offline authorization url with state and scopes", () => {
		const url = new URL(
			googleAuthorizationUrl(
				{ clientId: "client id", redirectUri: "https://app.example/callback" },
				{ state: "state/1", loginHint: "doc@example.com" },
			),
		);
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe("client id");
		expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("scope")?.split(" ")).toEqual([
			GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
			GOOGLE_CALENDARLIST_READONLY_SCOPE,
		]);
		expect(url.searchParams.get("state")).toBe("state/1");
		expect(url.searchParams.get("login_hint")).toBe("doc@example.com");
	});

	it("exchanges an auth code and maps expiry/refresh metadata", async () => {
		const fetchFn = fetcher((url, init) => {
			expect(url).toBe("https://oauth2.googleapis.com/token");
			expect(init?.method).toBe("POST");
			const body = new URLSearchParams(bodyText(init?.body));
			expect(body.get("client_id")).toBe("cid");
			expect(body.get("client_secret")).toBe("secret");
			expect(body.get("code")).toBe("code-1");
			expect(body.get("grant_type")).toBe("authorization_code");
			return json({ access_token: "access", refresh_token: "refresh", expires_in: 60, scope: "s" });
		});
		const before = Date.now();
		const token = await exchangeGoogleOAuthCode(
			{ clientId: "cid", clientSecret: "secret", redirectUri: "https://app/cb" },
			"code-1",
			fetchFn,
		);
		expect(token.accessToken).toBe("access");
		expect(token.refreshToken).toBe("refresh");
		expect(token.scope).toBe("s");
		expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 59_000);
	});

	it("refreshes an access token", async () => {
		const fetchFn = fetcher((_url, init) => {
			const body = new URLSearchParams(bodyText(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-1");
			return json({ access_token: "access-2" });
		});
		const token = await refreshGoogleAccessToken(
			{ clientId: "cid", clientSecret: "secret" },
			"refresh-1",
			fetchFn,
		);
		expect(token).toEqual({ accessToken: "access-2" });
	});

	it("fails token exchange without leaking response details", async () => {
		const error = await exchangeGoogleOAuthCode(
			{ clientId: "cid", clientSecret: "secret", redirectUri: "https://app/cb" },
			"bad",
			fetcher(() => json({ error: "invalid_grant" }, 400)),
		).catch((e) => e);
		expect(error).toBeInstanceOf(GoogleCalendarApiError);
		expect(error.status).toBe(400);
		expect(error.message).not.toContain("invalid_grant");
	});
});

describe("google external calendar", () => {
	const connect = async (fetchFn: typeof fetch) =>
		makeGoogleCalendarProvider({ fetchFn }).connect({ accessToken: "token" });

	it("requires an access token", async () => {
		const error = await makeGoogleCalendarProvider()
			.connect({})
			.catch((e) => e);
		expect(error).toBeInstanceOf(GoogleCalendarApiError);
		expect(error.status).toBe(401);
	});

	it("lists calendars with pagination and read-only roles", async () => {
		const calls: string[] = [];
		const fetchFn = fetcher((url) => {
			calls.push(url);
			if (!url.includes("pageToken=next")) {
				return json({
					items: [
						{ id: "primary", summary: "Main", primary: true, accessRole: "owner" },
						{ id: "shared", summary: "Shared", accessRole: "reader" },
						{ summary: "invalid" },
					],
					nextPageToken: "next",
				});
			}
			return json({ items: [{ id: "team", accessRole: "writer" }] });
		});
		const cal = await connect(fetchFn);
		expect(await cal.listCalendars!()).toEqual([
			{ id: "primary", name: "Main", primary: true },
			{ id: "shared", name: "Shared", readOnly: true },
			{ id: "team", name: "team" },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("/users/me/calendarList?");
	});

	it("lists bounded events with recurrence expansion and pagination", async () => {
		const urls: string[] = [];
		const fetchFn = fetcher((url) => {
			urls.push(url);
			if (!url.includes("pageToken=p2")) {
				return json({
					items: [
						event,
						{
							id: "all-day",
							start: { date: "2026-11-21" },
							end: { date: "2026-11-22" },
						},
						{ id: "invalid" },
					],
					nextPageToken: "p2",
				});
			}
			return json({ items: [{ ...event, id: "evt-2" }] });
		});
		const cal = await connect(fetchFn);
		const events = await cal.listEvents("primary", {
			from: new Date("2026-11-20T00:00:00Z"),
			to: new Date("2026-11-28T00:00:00Z"),
			expandRecurring: true,
		});
		expect(events.map((e) => e.id)).toEqual(["evt-1", "all-day", "evt-2"]);
		expect(events[0]).toMatchObject({
			calendarId: "primary",
			title: "Consulta — J.S.",
			description: "apt-42",
			etag: '"etag"',
			status: "confirmed",
			allDay: false,
		});
		expect(events[1]?.allDay).toBe(true);
		const first = new URL(urls[0]!);
		expect(first.searchParams.get("timeMin")).toBe("2026-11-20T00:00:00.000Z");
		expect(first.searchParams.get("timeMax")).toBe("2026-11-28T00:00:00.000Z");
		expect(first.searchParams.get("singleEvents")).toBe("true");
		expect(first.searchParams.get("showDeleted")).toBe("true");
		expect(first.searchParams.get("orderBy")).toBe("startTime");
		expect(first.pathname).toBe("/calendar/v3/calendars/primary/events");
		expect(urls).toHaveLength(2);
	});

	it("creates, updates and cancels events", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchFn = fetcher((url, init) => {
			calls.push({ url, init });
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			return json(event);
		});
		const cal = await connect(fetchFn);
		const draft: ExternalEventDraft = {
			title: "Consulta — J.S.",
			startsAt: new Date("2026-11-20T14:00:00Z"),
			endsAt: new Date("2026-11-20T14:30:00Z"),
			description: "apt-42",
		};
		expect((await cal.createEvent("primary", draft)).id).toBe("evt-1");
		expect((await cal.updateEvent("primary", "evt-1", draft, '"etag"')).id).toBe("evt-1");
		await cal.cancelEvent("primary", "evt-1");
		expect(calls.map((c) => c.init?.method)).toEqual(["POST", "PATCH", "DELETE"]);
		const createBody = JSON.parse(bodyText(calls[0]!.init?.body));
		expect(createBody.summary).toBe(draft.title);
		expect(createBody.start.dateTime).toBe(draft.startsAt.toISOString());
		expect(calls[1]?.init?.headers).toMatchObject({ "if-match": '"etag"' });
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer token" });
	});

	it("syncs incrementally, paginates and separates tombstones", async () => {
		const urls: string[] = [];
		const fetchFn = fetcher((url) => {
			urls.push(url);
			if (!url.includes("pageToken=p2")) {
				return json({
					items: [event, { ...event, id: "gone", status: "cancelled" }],
					nextPageToken: "p2",
				});
			}
			return json({ items: [{ ...event, id: "evt-2" }], nextSyncToken: "sync-2" });
		});
		const cal = await connect(fetchFn);
		const page = await cal.syncEvents("primary", "sync-1");
		expect(page.events.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
		expect(page.deletedIds).toEqual(["gone"]);
		expect(page.nextSyncToken).toBe("sync-2");
		const first = new URL(urls[0]!);
		expect(first.searchParams.get("syncToken")).toBe("sync-1");
		expect(first.searchParams.get("timeMin")).toBeNull();
		expect(first.searchParams.get("orderBy")).toBeNull();
	});

	it("raises provider errors with status", async () => {
		const cal = await connect(fetcher(() => json({}, 429)));
		const error = await cal.listEvents("primary").catch((e) => e);
		expect(error).toBeInstanceOf(GoogleCalendarApiError);
		expect(error.status).toBe(429);
		expect(error.provider).toBe("google");
	});
});

describe("provider oauth operations", () => {
	it("omits oauth without client config and exposes it with config", async () => {
		expect(makeGoogleCalendarProvider().oauth).toBeUndefined();
		const fetchFn = fetcher(() => json({ access_token: "access" }));
		const provider = makeGoogleCalendarProvider({
			fetchFn,
			oauth: { clientId: "cid", clientSecret: "secret", redirectUri: "https://app/cb" },
		});
		expect(provider.oauth).toBeDefined();
		expect(provider.oauth!.authorizationUrl({ state: "state" })).toContain("state=state");
		expect((await provider.oauth!.exchangeCode("code")).accessToken).toBe("access");
		expect((await provider.oauth!.refresh({ refreshToken: "refresh" })).refreshToken).toBe(
			"refresh",
		);
		await expect(provider.oauth!.refresh({})).rejects.toBeInstanceOf(GoogleCalendarApiError);
	});
});

describe("googleCalendarsDriver", () => {
	it("provides a registry containing the google adapter", async () => {
		const layer = googleCalendarsDriver.provides({}) as Layer.Layer<Calendars>;
		const registry = await Effect.runPromise(Effect.service(Calendars).pipe(Effect.provide(layer)));
		expect(registry.providers()).toEqual(["google"]);
		expect(registry.provider("google")).toBeDefined();
		expect(registry.provider("google")?.oauth).toBeUndefined();
	});

	it("wires oauth config from the deployment env when present", async () => {
		const layer = googleCalendarsDriver.provides({
			GOOGLE_CLIENT_ID: "cid",
			GOOGLE_CLIENT_SECRET: "secret",
			GOOGLE_OAUTH_REDIRECT_URI: "https://app/cb",
		}) as Layer.Layer<Calendars>;
		const registry = await Effect.runPromise(Effect.service(Calendars).pipe(Effect.provide(layer)));
		expect(registry.provider("google")?.oauth).toBeDefined();
	});
});
