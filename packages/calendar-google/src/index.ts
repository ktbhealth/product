import * as Layer from "effect/Layer";

import {
	CalendarSyncError,
	Calendars,
	evaluateEventFilter,
	makeCalendarsRegistry,
	type CalendarCredentials,
	type CalendarListQuery,
	type CalendarProvider,
	type ExternalCalendar,
	type ExternalCalendarEvent,
	type ExternalCalendarInfo,
	type ExternalEventDraft,
} from "@ktb/calendar";
import type { Driver } from "@ktb/driver-framework";
import { partitionFilter, type FilterExpr } from "@ktb/filters";

export const GOOGLE_PROVIDER_ID = "google";
export const GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE =
	"https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_CALENDARLIST_READONLY_SCOPE =
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleCalendarApiError extends CalendarSyncError {
	readonly status: number;
	constructor(message: string, status: number, options?: { cause?: unknown }) {
		super(message, { ...options, provider: GOOGLE_PROVIDER_ID });
		this.name = "GoogleCalendarApiError";
		this.status = status;
	}
}

export interface GoogleOAuthTokenSet {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: Date;
	readonly scope?: string;
	readonly tokenType?: string;
}

export interface GoogleOAuthClientConfig {
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly redirectUri: string;
}

export interface GoogleCalendarAdapterOptions {
	readonly fetchFn?: typeof fetch;
	readonly apiBase?: string;
	readonly tokenUrl?: string;
	/** OAuth client config resolved at the composition root. Absent → the
	 * provider can still use already-issued access tokens, but user connect
	 * and refresh are unavailable. */
	readonly oauth?: GoogleOAuthClientConfig & { readonly clientSecret: string };
}

/** Env slice the Google calendar driver inspects (mirrors app-host AppEnv). */
export interface GoogleCalendarDriverEnv {
	readonly GOOGLE_CLIENT_ID?: string;
	readonly GOOGLE_CLIENT_SECRET?: string;
	readonly GOOGLE_OAUTH_REDIRECT_URI?: string;
}

export const googleAuthorizationUrl = (
	config: GoogleOAuthClientConfig,
	input: {
		readonly state: string;
		readonly scopes?: readonly string[];
		readonly loginHint?: string;
	},
): string => {
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		access_type: "offline",
		prompt: "consent",
		scope: (input.scopes ?? [GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]).join(" "),
		state: input.state,
	});
	if (input.loginHint !== undefined) params.set("login_hint", input.loginHint);
	return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
};

interface GoogleTokenResponse {
	readonly access_token?: string;
	readonly refresh_token?: string;
	readonly expires_in?: number;
	readonly scope?: string;
	readonly token_type?: string;
}

const tokenSet = (json: GoogleTokenResponse, now = Date.now()): GoogleOAuthTokenSet => {
	if (typeof json.access_token !== "string" || json.access_token === "") {
		throw new GoogleCalendarApiError("google oauth response missing access token", 500);
	}
	return {
		accessToken: json.access_token,
		...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
		...(typeof json.expires_in === "number"
			? { expiresAt: new Date(now + json.expires_in * 1000) }
			: {}),
		...(typeof json.scope === "string" ? { scope: json.scope } : {}),
		...(typeof json.token_type === "string" ? { tokenType: json.token_type } : {}),
	};
};

const tokenRequest = async (
	fetchFn: typeof fetch,
	body: URLSearchParams,
	tokenUrl = OAUTH_TOKEN_URL,
): Promise<GoogleOAuthTokenSet> => {
	const res = await fetchFn(tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		throw new GoogleCalendarApiError(
			`google oauth token request failed: ${res.status}`,
			res.status,
		);
	}
	return tokenSet((await res.json()) as GoogleTokenResponse);
};

export const exchangeGoogleOAuthCode = async (
	config: GoogleOAuthClientConfig & { readonly clientSecret: string },
	code: string,
	fetchFn: typeof fetch = fetch,
	tokenUrl = OAUTH_TOKEN_URL,
): Promise<GoogleOAuthTokenSet> =>
	tokenRequest(
		fetchFn,
		new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: config.redirectUri,
		}),
		tokenUrl,
	);

export const refreshGoogleAccessToken = async (
	config: { readonly clientId: string; readonly clientSecret: string },
	refreshToken: string,
	fetchFn: typeof fetch = fetch,
	tokenUrl = OAUTH_TOKEN_URL,
): Promise<GoogleOAuthTokenSet> =>
	tokenRequest(
		fetchFn,
		new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		tokenUrl,
	);

interface GoogleDateTime {
	readonly date?: string;
	readonly dateTime?: string;
	readonly timeZone?: string;
}

interface GoogleEventResource {
	readonly id?: string;
	readonly status?: string;
	readonly summary?: string;
	readonly description?: string;
	readonly etag?: string;
	readonly updated?: string;
	readonly start?: GoogleDateTime;
	readonly end?: GoogleDateTime;
	readonly location?: string;
	readonly eventType?: string;
	readonly transparency?: string;
	readonly organizer?: { readonly email?: string; readonly displayName?: string };
	readonly attendees?: readonly {
		readonly email?: string;
		readonly displayName?: string;
	}[];
	readonly extendedProperties?: {
		readonly private?: Record<string, string>;
		readonly shared?: Record<string, string>;
	};
}

interface GoogleEventsPage {
	readonly items?: readonly GoogleEventResource[];
	readonly nextPageToken?: string;
	readonly nextSyncToken?: string;
}

interface GoogleCalendarListPage {
	readonly items?: readonly {
		readonly id?: string;
		readonly summary?: string;
		readonly primary?: boolean;
		readonly accessRole?: string;
	}[];
	readonly nextPageToken?: string;
}

const parseGoogleDate = (
	value: GoogleDateTime | undefined,
): { date: Date; allDay: boolean } | null => {
	if (value?.dateTime !== undefined) {
		const date = new Date(value.dateTime);
		return Number.isNaN(date.getTime()) ? null : { date, allDay: false };
	}
	if (value?.date !== undefined) {
		const date = new Date(`${value.date}T00:00:00.000Z`);
		return Number.isNaN(date.getTime()) ? null : { date, allDay: true };
	}
	return null;
};

const toExternalEvent = (
	calendarId: string,
	resource: GoogleEventResource,
): ExternalCalendarEvent | null => {
	if (typeof resource.id !== "string" || resource.id === "") return null;
	const start = parseGoogleDate(resource.start);
	if (start === null) return null;
	const parsedEnd = parseGoogleDate(resource.end);
	const end = parsedEnd?.date ?? start.date;
	return {
		id: resource.id,
		calendarId,
		title: resource.summary ?? "",
		startsAt: start.date,
		endsAt: end,
		...(resource.description === undefined ? {} : { description: resource.description }),
		...(resource.etag === undefined ? {} : { etag: resource.etag }),
		status: resource.status === "cancelled" ? "cancelled" : "confirmed",
		allDay: start.allDay,
		...(resource.updated === undefined || Number.isNaN(new Date(resource.updated).getTime())
			? {}
			: { updatedAt: new Date(resource.updated) }),
		...(resource.location === undefined ? {} : { location: resource.location }),
		...(resource.eventType === undefined ? {} : { eventType: resource.eventType }),
		...(resource.transparency === undefined ? {} : { transparency: resource.transparency }),
		...(resource.organizer === undefined
			? {}
			: { organizer: resource.organizer.email ?? resource.organizer.displayName }),
		...(resource.attendees === undefined
			? {}
			: {
					attendees: resource.attendees.flatMap((a) =>
						[a.email, a.displayName].filter((v): v is string => typeof v === "string"),
					),
				}),
		...(resource.extendedProperties === undefined
			? {}
			: {
					properties: {
						...(resource.extendedProperties.shared ?? {}),
						...(resource.extendedProperties.private ?? {}),
					},
				}),
	};
};

// ---------------------------------------------------------------------------
// Filter pushdown — what events.list honors natively. Everything else
// evaluates locally over the same canonical field vocabulary, so the
// caller-visible semantics don't depend on which side answered.
//
// Mapping notes:
// - `endsAt gt X` → timeMin=X and `startsAt lt X` → timeMax=X are exact:
//   both API bounds are exclusive, matching gt/lt. gte/lte deliberately
//   do NOT push — the boundary inclusivity would silently mismatch.
// - `text contains X` → q=X is semantic-approximate: q is token-based
//   full text over the same surfaces, not a substring match. Pushing it
//   is still correct behaviorally for users (it is what Google's own
//   UI does) and avoids downloading entire calendars for a search.
// - `eventType in [...]` / `eq` → repeated eventTypes params.
// - `property.<key> eq value` → privateExtendedProperty=key=value.
// - Disjunctions/negations never push: repeating params is AND, so an
//   or-tree cannot be expressed in the query string.
// ---------------------------------------------------------------------------

const pushableLeaf = (expr: FilterExpr): boolean => {
	if (expr.op === "gt" && expr.field === "endsAt") return true;
	if (expr.op === "lt" && expr.field === "startsAt") return true;
	if (expr.op === "contains" && expr.field === "text") return true;
	if ((expr.op === "in" || expr.op === "eq") && expr.field === "eventType") return true;
	if (expr.op === "eq" && expr.field.startsWith("property.")) return true;
	return false;
};

/** Google's pushdown capability: the leaf rules above, conjunctively
 * composable only — repeating query parameters intersects, so `or`/`not`
 * trees are never expressible. */
export const googleCanPushTree = (expr: FilterExpr): boolean => {
	if (expr.op === "and") return expr.args.length > 0 && expr.args.every(googleCanPushTree);
	if (expr.op === "or" || expr.op === "not") return false;
	return pushableLeaf(expr);
};

/** Compile a pushable subtree (guaranteed by {@link googleCanPushTree})
 * into events.list query params. Contradictory window bounds collapse
 * honestly: multiple `endsAt gt` keep the tightest (max) bound, multiple
 * `startsAt lt` the earliest (min). */
export const compileGooglePushdown = (push: FilterExpr, params: URLSearchParams): void => {
	const leaves: FilterExpr[] = [];
	const collect = (expr: FilterExpr): void => {
		if (expr.op === "and") {
			for (const arg of expr.args) collect(arg);
			return;
		}
		leaves.push(expr);
	};
	collect(push);

	const textTerms: string[] = [];
	let timeMin: string | undefined;
	let timeMax: string | undefined;
	for (const leaf of leaves) {
		if (leaf.op === "gt" && leaf.field === "endsAt") {
			const iso = new Date(leaf.value).toISOString();
			if (timeMin === undefined || iso > timeMin) timeMin = iso;
			continue;
		}
		if (leaf.op === "lt" && leaf.field === "startsAt") {
			const iso = new Date(leaf.value).toISOString();
			if (timeMax === undefined || iso < timeMax) timeMax = iso;
			continue;
		}
		if (leaf.op === "contains" && leaf.field === "text") {
			textTerms.push(leaf.value);
			continue;
		}
		if (leaf.op === "eq" && leaf.field === "eventType" && typeof leaf.value === "string") {
			params.append("eventTypes", leaf.value);
			continue;
		}
		if (leaf.op === "in" && leaf.field === "eventType") {
			for (const value of leaf.values) {
				if (typeof value === "string") params.append("eventTypes", value);
			}
			continue;
		}
		if (leaf.op === "eq" && leaf.field.startsWith("property.") && typeof leaf.value === "string") {
			params.append(
				"privateExtendedProperty",
				`${leaf.field.slice("property.".length)}=${leaf.value}`,
			);
			continue;
		}
	}
	if (timeMin !== undefined) params.set("timeMin", timeMin);
	if (timeMax !== undefined) params.set("timeMax", timeMax);
	if (textTerms.length > 0) params.set("q", textTerms.join(" "));
};

const eventBody = (draft: ExternalEventDraft) => ({
	summary: draft.title,
	...(draft.description === undefined ? {} : { description: draft.description }),
	start: { dateTime: draft.startsAt.toISOString() },
	end: { dateTime: draft.endsAt.toISOString() },
});

export class GoogleExternalCalendar implements ExternalCalendar {
	readonly provider = GOOGLE_PROVIDER_ID;

	constructor(
		private readonly accessToken: string,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly apiBase = API_BASE,
	) {}

	private async request<T>(
		path: string,
		init: RequestInit = {},
		options: { readonly expectJson?: boolean } = {},
	): Promise<T> {
		const res = await this.fetchFn(`${this.apiBase}${path}`, {
			...init,
			headers: {
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
				...Object.fromEntries(new Headers(init.headers).entries()),
				authorization: `Bearer ${this.accessToken}`,
			},
		});
		if (!res.ok) {
			throw new GoogleCalendarApiError(`google calendar request failed: ${res.status}`, res.status);
		}
		if (options.expectJson === false || res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}

	async listCalendars(): Promise<readonly ExternalCalendarInfo[]> {
		const calendars: ExternalCalendarInfo[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({ maxResults: "250" });
			if (pageToken !== undefined) params.set("pageToken", pageToken);
			const page = await this.request<GoogleCalendarListPage>(`/users/me/calendarList?${params}`);
			for (const item of page.items ?? []) {
				if (typeof item.id !== "string" || item.id === "") continue;
				calendars.push({
					id: item.id,
					name: item.summary ?? item.id,
					...(item.primary === true ? { primary: true } : {}),
					...(item.accessRole === "reader" || item.accessRole === "freeBusyReader"
						? { readOnly: true }
						: {}),
				});
			}
			pageToken = page.nextPageToken;
		} while (pageToken !== undefined);
		return calendars;
	}

	private eventsPath(calendarId: string, params: URLSearchParams): string {
		return `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
	}

	async listEvents(
		calendarId: string,
		query: CalendarListQuery = {},
	): Promise<readonly ExternalCalendarEvent[]> {
		// Filter partitioning: the push side compiles into query params,
		// the residual evaluates locally over the same field vocabulary —
		// the caller-visible result is the full filter either way.
		const partition =
			query.filter === undefined
				? { push: null, residual: null }
				: partitionFilter(query.filter, googleCanPushTree);
		const events: ExternalCalendarEvent[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({ maxResults: "2500" });
			if (query.from !== undefined) params.set("timeMin", query.from.toISOString());
			if (query.to !== undefined) params.set("timeMax", query.to.toISOString());
			if (partition.push !== null) compileGooglePushdown(partition.push, params);
			if (query.expandRecurring === true) {
				params.set("singleEvents", "true");
				params.set("orderBy", "startTime");
			}
			if (pageToken !== undefined) params.set("pageToken", pageToken);
			const page = await this.request<GoogleEventsPage>(this.eventsPath(calendarId, params));
			for (const item of page.items ?? []) {
				const event = toExternalEvent(calendarId, item);
				if (event === null) continue;
				if (partition.residual !== null && !evaluateEventFilter(partition.residual, event))
					continue;
				events.push(event);
			}
			pageToken = page.nextPageToken;
		} while (pageToken !== undefined);
		return events;
	}

	async createEvent(calendarId: string, draft: ExternalEventDraft): Promise<ExternalCalendarEvent> {
		const resource = await this.request<GoogleEventResource>(
			`/calendars/${encodeURIComponent(calendarId)}/events`,
			{ method: "POST", body: JSON.stringify(eventBody(draft)) },
		);
		const event = toExternalEvent(calendarId, resource);
		if (event === null)
			throw new GoogleCalendarApiError("google create returned an invalid event", 500);
		return event;
	}

	async updateEvent(
		calendarId: string,
		eventId: string,
		draft: ExternalEventDraft,
		etag?: string,
	): Promise<ExternalCalendarEvent> {
		const resource = await this.request<GoogleEventResource>(
			`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{
				method: "PATCH",
				body: JSON.stringify(eventBody(draft)),
				...(etag === undefined ? {} : { headers: { "if-match": etag } }),
			},
		);
		const event = toExternalEvent(calendarId, resource);
		if (event === null)
			throw new GoogleCalendarApiError("google update returned an invalid event", 500);
		return event;
	}

	async cancelEvent(calendarId: string, eventId: string): Promise<void> {
		await this.request<undefined>(
			`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE" },
			{ expectJson: false },
		);
	}

	async syncEvents(calendarId: string, syncToken: string | null) {
		const events: ExternalCalendarEvent[] = [];
		const deletedIds: string[] = [];
		let pageToken: string | undefined;
		let nextSyncToken = syncToken ?? "";
		do {
			const params = new URLSearchParams({ maxResults: "2500" });
			if (syncToken !== null) params.set("syncToken", syncToken);
			if (pageToken !== undefined) params.set("pageToken", pageToken);
			const page = await this.request<GoogleEventsPage>(this.eventsPath(calendarId, params));
			for (const item of page.items ?? []) {
				const event = toExternalEvent(calendarId, item);
				if (event === null) continue;
				if (event.status === "cancelled") deletedIds.push(event.id);
				else events.push(event);
			}
			nextSyncToken = page.nextSyncToken ?? nextSyncToken;
			pageToken = page.nextPageToken;
		} while (pageToken !== undefined);
		return { events, deletedIds, nextSyncToken };
	}
}

const credentialsFromTokenSet = (
	token: GoogleOAuthTokenSet,
	fallbackRefreshToken?: string,
): CalendarCredentials => ({
	accessToken: token.accessToken,
	...(token.refreshToken !== undefined
		? { refreshToken: token.refreshToken }
		: fallbackRefreshToken !== undefined
			? { refreshToken: fallbackRefreshToken }
			: {}),
	...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt.toISOString() }),
	...(token.scope === undefined ? {} : { scope: token.scope }),
	...(token.tokenType === undefined ? {} : { tokenType: token.tokenType }),
});

export const makeGoogleCalendarProvider = (
	options: GoogleCalendarAdapterOptions = {},
): CalendarProvider => {
	const oauthConfig = options.oauth;
	return {
		id: GOOGLE_PROVIDER_ID,
		...(oauthConfig === undefined
			? {}
			: {
					oauth: {
						authorizationUrl: ({ state, scopes }) =>
							googleAuthorizationUrl(oauthConfig, {
								state,
								...(scopes === undefined ? {} : { scopes }),
							}),
						exchangeCode: async (code) =>
							credentialsFromTokenSet(
								await exchangeGoogleOAuthCode(
									oauthConfig,
									code,
									options.fetchFn ?? fetch,
									options.tokenUrl ?? OAUTH_TOKEN_URL,
								),
							),
						refresh: async (credentials) => {
							const refreshToken = credentials.refreshToken;
							if (typeof refreshToken !== "string" || refreshToken === "") {
								throw new GoogleCalendarApiError("google connection requires a refresh token", 401);
							}
							return credentialsFromTokenSet(
								await refreshGoogleAccessToken(
									oauthConfig,
									refreshToken,
									options.fetchFn ?? fetch,
									options.tokenUrl ?? OAUTH_TOKEN_URL,
								),
								refreshToken,
							);
						},
					},
				}),
		connect: async (credentials: CalendarCredentials): Promise<ExternalCalendar> => {
			const accessToken = credentials.accessToken;
			if (typeof accessToken !== "string" || accessToken === "") {
				throw new GoogleCalendarApiError("google connection requires an access token", 401);
			}
			return new GoogleExternalCalendar(
				accessToken,
				options.fetchFn ?? fetch,
				options.apiBase ?? API_BASE,
			);
		},
	};
};

/** Google-backed calendar registry driver. The provider itself needs no
 * deployment env: per-user OAuth tokens arrive in `connect` credentials;
 * OAuth client id/secret are consumed only by the connect/callback edge. */
export const googleCalendarsDriver: Driver<unknown> = {
	id: "calendar-google",
	port: Calendars.key,
	provides: (env) => {
		const e = env as GoogleCalendarDriverEnv;
		const oauth =
			e.GOOGLE_CLIENT_ID !== undefined &&
			e.GOOGLE_CLIENT_SECRET !== undefined &&
			e.GOOGLE_OAUTH_REDIRECT_URI !== undefined
				? {
						clientId: e.GOOGLE_CLIENT_ID,
						clientSecret: e.GOOGLE_CLIENT_SECRET,
						redirectUri: e.GOOGLE_OAUTH_REDIRECT_URI,
					}
				: undefined;
		return Layer.succeed(
			Calendars,
			makeCalendarsRegistry([
				makeGoogleCalendarProvider({ ...(oauth === undefined ? {} : { oauth }) }),
			]),
		);
	},
};
