import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Driver } from "@ktb/driver-framework";

/**
 * @ktb/calendar — the external-calendar sync port (P-008). Provider
 * adapters implement {@link ExternalCalendar} for one bound connection
 * (Google Calendar first; Outlook/Graph, CalDAV later); the local
 * `appointments` table stays the source of truth for consult links and
 * statuses — adapters only mirror/sync.
 *
 * PHI contract (LGPD — see proposal-0008 cautions): nothing crossing
 * this port may carry clinical data or full patient names. Titles are
 * initials or a generic label plus the internal appointment id; the
 * doctor's own calendar already implies the rest. Adapters that leak
 * PHI are contract violations, not configuration choices.
 */

/** What the local system asks an adapter to materialize as an event. */
export interface ExternalEventDraft {
	/** e.g. "Consulta — J.S." or a generic label; never a full name. */
	readonly title: string;
	readonly startsAt: Date;
	readonly endsAt: Date;
	/** Optional opaque reference (internal link/id), never PHI. */
	readonly description?: string;
}

/** Bounded read options for one-shot imports. Continuous synchronization
 * uses {@link ExternalCalendar.syncEvents} instead — providers commonly
 * forbid mixing delta tokens with date filters. */
export interface CalendarListQuery {
	/** Lower bound for events overlapping the window. */
	readonly from?: Date;
	/** Upper bound for events overlapping the window. */
	readonly to?: Date;
	/** Expand recurring series into instances when the provider can. */
	readonly expandRecurring?: boolean;
}

/** Wire shape of an event read from or written to a provider. */
export interface ExternalCalendarEvent extends ExternalEventDraft {
	/** Provider-side event id — stored on the appointment row. */
	readonly id: string;
	/** Provider-side calendar this event belongs to. */
	readonly calendarId: string;
	/** Concurrency token for conditional updates when the provider has one. */
	readonly etag?: string;
	/** "cancelled" when the provider tombstones instead of deleting. */
	readonly status?: "confirmed" | "cancelled";
	/** Date-only event — imports normally treat these as blocks, not consults. */
	readonly allDay?: boolean;
	readonly updatedAt?: Date;
}

/** A calendar collection exposed by a connected provider account. */
export interface ExternalCalendarInfo {
	readonly id: string;
	readonly name: string;
	readonly primary?: boolean;
	readonly readOnly?: boolean;
}

/** A provider call failed — network, auth, or quota. Callers may retry. */
export class CalendarSyncError extends Error {
	readonly provider?: string;
	constructor(message: string, options?: { cause?: unknown; provider?: string }) {
		super(message, options);
		this.name = "CalendarSyncError";
		this.provider = options?.provider;
	}
}

/** Result of one delta-sync page. `nextSyncToken` is opaque adapter
 * state — persist it verbatim; a null token means "next call is a full
 * sync". */
export interface CalendarSyncPage {
	readonly events: readonly ExternalCalendarEvent[];
	/** Ids the provider reports as deleted/cancelled since the last sync. */
	readonly deletedIds: readonly string[];
	readonly nextSyncToken: string;
}

/** A live change-notification channel — webhook/push where the provider
 * offers one. `stop` releases it (channel teardown, token revocation). */
export interface CalendarWatch {
	readonly channelId: string;
	readonly expiresAt: Date;
	stop(): Promise<void>;
}

/** Push notification delivered on a watch channel — the payload is a
 * poke, not data: consumers re-run {@link ExternalCalendar.syncEvents}. */
export interface CalendarWatchNotification {
	readonly channelId: string;
	readonly calendarId: string;
}

/**
 * One connected external calendar account — what a sync job or the
 * agenda service holds after `CalendarProvider.connect`. Implementations
 * live in sibling adapter packages; nothing here may import a provider
 * SDK, endpoint literal, or platform binding (arch policy).
 */
export interface ExternalCalendar {
	/** Adapter's provider id — an opaque key, never a hardcoded literal here. */
	readonly provider: string;
	/** Calendars visible to the connected account; absent for adapters that
	 * only support one implicitly configured collection. */
	listCalendars?(): Promise<readonly ExternalCalendarInfo[]>;
	listEvents(
		calendarId: string,
		query?: CalendarListQuery,
	): Promise<readonly ExternalCalendarEvent[]>;
	createEvent(calendarId: string, draft: ExternalEventDraft): Promise<ExternalCalendarEvent>;
	/** `etag` enables conditional writes; adapters without etag support ignore it. */
	updateEvent(
		calendarId: string,
		eventId: string,
		draft: ExternalEventDraft,
		etag?: string,
	): Promise<ExternalCalendarEvent>;
	cancelEvent(calendarId: string, eventId: string): Promise<void>;
	/** Pull changes since `syncToken` (null → full sync). Poll-capable
	 * adapters implement this as a delta query; webhook-first adapters
	 * still must, since channels only poke. */
	syncEvents(calendarId: string, syncToken: string | null): Promise<CalendarSyncPage>;
	/** Register a change channel; absent means the adapter is poll-only. */
	watch?(
		calendarId: string,
		onNotify: (n: CalendarWatchNotification) => void,
	): Promise<CalendarWatch>;
}

/** Credentials a provider needs to open a connection — opaque to the
 * port; each adapter narrows it (OAuth tokens, app passwords, ...). */
export type CalendarCredentials = Record<string, unknown>;

/** OAuth operations some calendar providers expose for user-account
 * connections. Credentials remain opaque provider-specific data; callers
 * persist the serialized object in a secret store and pass it back to
 * `connect`/`refresh`. */
export interface CalendarOAuthOperations {
	/** URL the user is redirected to in order to authorize the connection. */
	authorizationUrl(input: { readonly state: string; readonly scopes?: readonly string[] }): string;
	/** Exchange the redirect callback's authorization code for tokens. */
	exchangeCode(code: string): Promise<CalendarCredentials>;
	/** Refresh expired credentials; providers may rotate refresh tokens. */
	refresh(credentials: CalendarCredentials): Promise<CalendarCredentials>;
}

/** Adapter factory: one per provider, registered at the edge. */
export interface CalendarProvider {
	/** Stable provider key stored on synced rows, e.g. from the adapter
	 * package — the port never enumerates valid values. */
	readonly id: string;
	/** OAuth connection machinery when the provider supports it. Absent
	 * for credential schemes such as CalDAV app passwords. */
	readonly oauth?: CalendarOAuthOperations;
	connect(credentials: CalendarCredentials): Promise<ExternalCalendar>;
}

/** What plugins see: the registered provider adapters, keyed by id. */
export interface CalendarsRegistry {
	readonly provider: (id: string) => CalendarProvider | undefined;
	readonly providers: () => readonly string[];
}

/**
 * Calendar provider registry — empty in deployments with no external
 * calendar configured; sync-capable plugins degrade to local-only.
 */
export class Calendars extends Context.Service<Calendars, CalendarsRegistry>()(
	"@ktb/calendar/Calendars",
) {}

/** Registry over a fixed adapter set — the composition root builds one. */
export const makeCalendarsRegistry = (adapters: readonly CalendarProvider[]): CalendarsRegistry => {
	const byId = new Map(adapters.map((a) => [a.id, a]));
	return {
		provider: (id) => byId.get(id),
		providers: () => adapters.map((a) => a.id),
	};
};

/** Env slice read by calendar drivers (mirrors app-host AppEnv). The
 * base port declares no keys of its own — each adapter package defines
 * the env it needs (OAuth client ids, webhook secrets, ...). */
export interface CalendarDriverEnv {}

/** No-provider registry: Calendars resolves to an empty set. Last in
 * the driver list — a provider driver wins whenever one is eligible. */
export const nullCalendarsDriver: Driver<CalendarDriverEnv> = {
	id: "calendar-none",
	port: Calendars.key,
	provides: () => Layer.succeed(Calendars, makeCalendarsRegistry([])),
};

// ---------------------------------------------------------------------------
// In-memory adapter — contract fixture for tests and dev; also the
// reference implementation adapters are measured against.
// ---------------------------------------------------------------------------

/** Options accepted by {@link makeMemoryCalendarProvider}. */
export interface MemoryCalendarOptions {
	readonly provider?: string;
	readonly now?: () => number;
}

let memorySeq = 0;

/**
 * In-memory {@link CalendarProvider}: every `connect` returns an
 * {@link ExternalCalendar} backed by a private map — per-connection
 * isolation like a real account. Sync tokens are a monotone sequence;
 * `watch` is deliberately absent (poll-only adapter). Tests, dev and
 * contract checks use this; production deployments bind real adapters.
 */
export const makeMemoryCalendarProvider = (
	options: MemoryCalendarOptions = {},
): CalendarProvider => {
	const provider = options.provider ?? "memory";
	const now = options.now ?? (() => Date.now());
	return {
		id: provider,
		connect: async () => {
			const events = new Map<string, Map<string, ExternalCalendarEvent>>();
			let clock = 0;
			const tick = () => `${++clock}`;
			const calendar = (calendarId: string) => {
				let cal = events.get(calendarId);
				if (cal === undefined) {
					cal = new Map();
					events.set(calendarId, cal);
				}
				return cal;
			};
			return {
				provider,
				listEvents: async (calendarId, query) =>
					[...calendar(calendarId).values()].filter((event) => {
						const start = event.startsAt.getTime();
						const end = event.endsAt.getTime();
						if (query?.from !== undefined && end < query.from.getTime()) return false;
						if (query?.to !== undefined && start >= query.to.getTime()) return false;
						return true;
					}),
				createEvent: async (calendarId, draft) => {
					const event: ExternalCalendarEvent = {
						...draft,
						id: `${provider}-evt-${++memorySeq}`,
						calendarId,
						status: "confirmed",
						updatedAt: new Date(now()),
					};
					calendar(calendarId).set(event.id, event);
					return event;
				},
				updateEvent: async (calendarId, eventId, draft) => {
					const cal = calendar(calendarId);
					const existing = cal.get(eventId);
					if (existing === undefined) {
						throw new CalendarSyncError(`unknown event ${eventId}`, { provider });
					}
					const next: ExternalCalendarEvent = {
						...existing,
						...draft,
						updatedAt: new Date(now()),
					};
					cal.set(eventId, next);
					return next;
				},
				cancelEvent: async (calendarId, eventId) => {
					calendar(calendarId).delete(eventId);
				},
				syncEvents: async (calendarId) => ({
					events: [...calendar(calendarId).values()],
					deletedIds: [],
					nextSyncToken: tick(),
				}),
			};
		},
	};
};
