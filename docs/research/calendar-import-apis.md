# Research note — importing events from external calendar providers

Scope: primary/official sources on endpoints and mechanisms for importing events
from Google Calendar, Microsoft Outlook/Graph, Apple iCloud Calendar, and generic
CalDAV. Focus: exact list endpoints, OAuth scopes, incremental sync and pagination,
one-shot import vs continuous sync, provider equivalents, limitations and
recommendations. No implementation.

---

## 1. Google Calendar

### 1.1 Exact endpoint for listing events

The Calendar API v3 `events.list` method is:

```
GET https://www.googleapis.com/calendar/v3/calendars/calendarId/events
```

- `calendarId` is a calendar identifier; use the keyword `primary` for the
  primary calendar of the currently authenticated user. Calendar IDs are
  obtained via `calendarList.list`.
- Source: <https://developers.google.com/workspace/calendar/api/v3/reference/events/list>

Relevant query parameters (same reference):

- `maxResults` — maximum events per page; default 250, hard ceiling 2500.
- `pageToken` — page selection token; the response exposes `nextPageToken` when
  more results exist. Incomplete pages can be detected by a non-empty
  `nextPageToken`.
- `orderBy` — `startTime` (only when `singleEvents=true`) or `updated`.
- `showDeleted` — include cancelled events; deleted instances behave
  differently depending on `singleEvents`.
- `timeMin`/`timeMax`, `singleEvents` (expand recurring events into instances),
  `syncToken`, `updatedMin`.

Related endpoints:

- `GET /calendar/v3/users/me/calendarList` — list the user's calendars
  (<https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list>).
- `GET /calendar/v3/calendars/calendarId/events/eventId` — get a single event
  (<https://developers.google.com/workspace/calendar/api/v3/reference/events/get>).
- `POST /calendar/v3/calendars/calendarId/events` — insert an event
  (<https://developers.google.com/workspace/calendar/api/v3/reference/events/insert>),
  which is what a true one-shot "import into Google" would use. For importing
  _from_ Google into our system, `events.list` (+ optional batching) suffices.

### 1.2 OAuth scopes

Per the `events.list` reference, the method requires one of:

- `https://www.googleapis.com/auth/calendar.readonly` — read-only access to
  all calendar data (recommended minimum for import/read).
- `https://www.googleapis.com/auth/calendar` — full read/write.
- `https://www.googleapis.com/auth/calendar.events.readonly` — read-only,
  events only.
- `https://www.googleapis.com/auth/calendar.events` — read/write, events only.

Sources: scope list at
<https://developers.google.com/workspace/calendar/api/v3/reference/events/list#auth>
and the auth guide
<https://developers.google.com/workspace/calendar/api/auth>.

Note: Google classifies the full `calendar` scope as **sensitive/restricted**
in OAuth verification; apps using restricted scopes must pass Google OAuth app
verification (and, for restricted scopes, a security assessment).
Reference: <https://support.google.com/cloud/answer/10311615> and
<https://developers.google.com/workspace/calendar/api/guides/api-audit> (restricted
scope policy for Calendar). Prefer `calendar.readonly` or
`calendar.events.readonly` to reduce verification burden.

### 1.3 Incremental sync: syncToken and pagination

Google documents a two-stage "incremental synchronization" model at
<https://developers.google.com/workspace/calendar/api/guides/sync>:

1. **Initial full sync** — one full `events.list` pass. If the result set is
   paginated, `nextSyncToken` appears **only on the last page**. The client
   persists this token. Entries created during pagination are not missed —
   the information needed for a correct sync token is encoded in the page token.
2. **Incremental sync** — subsequent `events.list` calls pass
   `syncToken=<nextSyncToken>`; the response contains only entries changed
   since then, plus a new `nextSyncToken` on its last page.

Key rules and constraints (same guide plus the `events.list` reference):

- All events **deleted** since the previous sync are always returned (with
  `status: "cancelled"`); when using `syncToken` you may not set
  `showDeleted=false` behavior arbitrarily — deleted entries are forced into
  the result set so tombstones propagate.
- The following query parameters **cannot** be combined with `syncToken` (to
  keep client state consistent): `orderBy`, `privateExtendedProperty`, `q`,
  `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin` — i.e. incremental
  sync is always a full-window sync of the whole calendar, not a date-range
  slice. See the `syncToken` parameter description at
  <https://developers.google.com/workspace/calendar/api/v3/reference/events/list>.
- If the token expires (server-side retention is finite), the server responds
  **410 GONE**; the client must wipe its local store and re-run a full sync.
  Source: <https://developers.google.com/workspace/calendar/api/guides/sync>.
- `updatedMin` is a weaker fallback mechanism (filter by last-modified time)
  for clients that don't use sync tokens; the guide recommends tokens.

### 1.4 Import vs continuous sync

- **One-shot import**: a single full-sync pass (without persisting
  `nextSyncToken`) with `timeMin`/`timeMax` and `singleEvents=true` if you want
  expanded recurrence instances. No follow-up.
- **Continuous sync**: persist `syncToken` per calendar and poll incrementally,
  or combine with **push notifications** — the Calendar API supports watch
  channels: `POST /calendar/v3/calendars/calendarId/events/watch` registers a
  webhook channel (Google pushes change notifications to your HTTPS endpoint);
  notifications are lightweight ("something changed") and you still perform the
  incremental `events.list` sync to fetch the actual changes. Channels expire
  and must be renewed. Sources:
  <https://developers.google.com/workspace/calendar/api/guides/push> and
  <https://developers.google.com/workspace/calendar/api/v3/reference/events/watch>.

### 1.5 Limitations and recommendations (Google)

- Usage quotas apply per project/per minute; use exponential backoff. Source:
  <https://developers.google.com/workspace/calendar/api/guides/quota>.
- Recurring events: without `singleEvents=true` you get series masters with
  RFC 5545 `recurrence` RRULE strings that you must expand yourself.
- Sync tokens are per-calendar; a user typically has several calendars
  (including subscribed/read-only ones), each requiring its own sync state.
- Recommendation: use incremental sync + push notifications rather than
  periodic full re-listing; persist tokens atomically with the data.

---

## 2. Microsoft Outlook / Microsoft Graph

### 2.1 Exact endpoint for listing events

Microsoft Graph v1.0:

```
GET /me/calendar/events
GET /users/{id | userPrincipalName}/calendar/events
GET /groups/{id}/calendar/events
```

- Source: <https://learn.microsoft.com/en-us/graph/api/calendar-list-events?view=graph-rest-1.0>
- The list contains single-instance meetings and **series masters** — to get
  expanded instances you use the **calendar view**:
  `GET /me/calendarView?startDateTime=...&endDateTime=...`
  (<https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0>).
- Pagination via OData: `$top` page size, response `@odata.nextLink` with
  `$skipToken`. Throttling/page-size notes in
  <https://learn.microsoft.com/en-us/graph/paging>.

### 2.2 OAuth scopes / permissions

Per the `calendar-list-events` reference, reading events requires one of
(in order of least privilege):

- Delegated (work/school or personal MSA): `Calendars.ReadBasic`,
  `Calendars.Read`, `Calendars.ReadWrite`.
- Application: `Calendars.Read` / `Calendars.ReadBasic` / `Calendars.ReadWrite`.
- Group calendars: `Group.Read.All` / `Group.ReadWrite.All` (delegated only).

`Calendars.ReadBasic` returns only free/busy-ish basic properties — for real
import you want `Calendars.Read`. Sources: the reference above and the
permissions reference
<https://learn.microsoft.com/en-us/graph/permissions-reference>.

### 2.3 Incremental sync: delta query and pagination

Microsoft Graph's equivalent of `syncToken` is the **delta query**:

```
GET /me/calendarView/delta?startDateTime={start}&endDateTime={end}
```

- Source: <https://learn.microsoft.com/en-us/graph/delta-query-events>
- In v1.0, event delta is bound to a calendar **view** (fixed date range);
  tracking events across an unbounded calendar is beta-only per the same
  article (`delta function` note).
- The flow: initial request = full sync of the view; responses page through
  `@odata.nextLink` (`$skipToken` — more data in the same round) until the
  final page returns `@odata.deltaLink` containing the `$deltatoken`. Persist
  the deltaLink; subsequent rounds pass `$deltatoken` and return only changes,
  including deletions (represented as removed items / tombstones with a
  `reason` annotation). Sources: the article above and
  <https://learn.microsoft.com/en-us/graph/delta-query-overview>.
- Delta tokens can expire (410 Gone) — client falls back to full sync, same
  pattern as Google.
- Separate delta endpoints exist for the **calendar list itself**
  (`GET /me/calendars/delta`) — new/renamed/deleted calendars:
  <https://learn.microsoft.com/en-us/graph/api/calendar-delta?view=graph-rest-1.0>.

### 2.4 Import vs continuous sync (Graph)

- **One-shot import**: plain `GET /me/calendar/events` or `calendarView` for a
  bounded window.
- **Continuous sync**: delta query polling, optionally triggered by
  **change notifications (webhooks)** — Microsoft Graph subscriptions:
  `POST /subscriptions` with resource `/me/events` or
  `/users/{id}/events`; notifications fire on create/update/delete, and best
  practice is still to run a delta round to fetch actual data. Subscriptions
  have short max lifetimes (events: ~4230 minutes / under 3 days for Outlook
  resources) and must be renewed. Sources:
  <https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0>
  and <https://learn.microsoft.com/en-us/graph/webhooks>.
- Graph also supports **change notifications with resource data** (encrypted
  payloads) if you want the event in the notification itself.

### 2.5 Limitations and recommendations (Graph)

- Throttling: 429 responses with `Retry-After`; per-app/per-mailbox limits.
  <https://learn.microsoft.com/en-us/graph/throttling>.
- Private items caveat: reading another mailbox's calendar with private items
  requires special delegate flags (noted in the `calendar-list-events` reference).
- Delta on `calendarView` in v1.0 is range-bound — for continuous sync you pick
  a rolling window (e.g. ±6 months) which differs from Google's unbounded sync.
  Plan the window per product needs.
- National clouds (Gov, 21Vianet) expose these endpoints but with deployment
  differences (the `calendar: delta` table shows Gov/China gaps for calendar
  delta).

---

## 3. Apple Calendar / iCloud

### 3.1 No public REST/JSON API

Apple does **not** publish a public REST events API for iCloud Calendar.
The supported programmatic access path is **CalDAV** against iCloud's CalDAV
server (`https://caldav.icloud.com`, discovery sometimes documented as
`https://caldav.icloud.com/` with principal lookup via `/.well-known/caldav`).
Apple's only official touches on this area:

- App-specific passwords requirement for third-party app sign-in with Apple
  Account: <https://support.apple.com/en-us/102654> ("Sign in to apps with
  your Apple Account using app-specific passwords") — since 2025, third-party
  access to iCloud data **requires** an app-specific password (no primary
  password, no OAuth flow available to third parties).
- RFC-conformant CalDAV access is what macOS/iOS Calendar and tools like
  Thunderbird use; there is no Apple-issued scope model — authentication is
  HTTP Basic over TLS with the app-specific password (or the Apple Account
  password pre-2025).

Consequences:

- **No OAuth**, no granular read-only scopes — an app-specific password grants
  full CalDAV (read/write) access to the user's calendars. This is a major
  security/privacy limitation for a health product.
- No push-notification webhook mechanism; clients must **poll** (ctag/etag or
  sync-token REPORT, see §4).
- Credential revocation is manual by the user at appleid.apple.com.

### 3.2 Practical endpoint shape

Because iCloud is a standards-based CalDAV server, the interactions are the
generic CalDAV ones (next section) against `https://caldav.icloud.com`:

- `PROPFIND /.well-known/caldav` → principal → `calendar-home-set` → calendar
  collections.
- `REPORT` with `calendar-query` / `calendar-multiget` to fetch events as
  iCalendar (`.ics`) payloads, and `sync-collection` REPORT for incremental
  sync.

Apple's developer documentation covers the **EventKit** framework for
on-device access (<https://developer.apple.com/documentation/eventkit>), which
is irrelevant for a server-side product like ours — server-side iCloud access
is CalDAV-only.

---

## 4. Generic CalDAV (covers iCloud and standards-based servers)

### 4.1 Reading events

- Base standards: **RFC 4791** (CalDAV) — <https://www.rfc-editor.org/rfc/rfc4791>.
- Events are fetched with `REPORT` requests:
  - `calendar-query` REPORT — time-range filter (`time-range` on
    `VEVENT`/`DTSTART` etc.), returns iCalendar objects. RFC 4791 §7.9
    (<https://www.rfc-editor.org/rfc/rfc4791#section-7.9>).
  - `calendar-multiget` REPORT — fetch specific resources by href after
    listing. RFC 4791 §7.10.
- No OAuth in the base spec; auth is usually HTTP Basic/Bearer-over-TLS or
  OAuth-bearer where the server supports it (Fastmail, some others support
  app passwords + Basic).

### 4.2 Incremental sync

Two mechanisms:

1. **RFC 6578 Collection Synchronization (WebDAV sync)** —
   <https://www.rfc-editor.org/rfc/rfc6578>: `sync-collection` REPORT with a
   server-issued `sync-token`. Initial sync omits the token (full listing);
   the response ends with a new `sync-token`; later reports pass it and return
   only added/modified resources plus `<status>404</status>` entries for
   deletions (tombstones). iCloud supports this.
2. **ctag/etag fallback** — the calendar collection's
   `CS:getctag` (a CalDAV-Server-private extension, documented in
   <https://www.rfc-editor.org/rfc/rfc4791> era drafts and used widely) changes
   whenever anything in the collection changes; clients poll the ctag cheaply
   and re-sync on change, using per-event `getetag` for conditional updates.

### 4.3 Discovery flow

`/.well-known/caldav` (RFC 5785) → `PROPFIND` `current-user-principal` →
`PROPFIND` `calendar-home-set` (RFC 4791 §6.2.1) → `PROPFIND` the home for
calendar collections (`displayname`, `supported-calendar-component-set`,
ctag, sync-token support) → per-calendar `REPORT`s.

### 4.4 Limitations (generic CalDAV)

- No standardized push — pure polling; efficient polling relies on ctag or
  sync-token support, which varies by server.
- No standardized OAuth — credentials are usually full-access app passwords.
- Recurrence expansion is the client's job: you receive raw iCalendar VEVENTs
  with RRULEs and must expand (libraries: ical.js, rrule).
- Server quirks abound (iCloud URL behavior, event href migrations); the
  sync-token may become invalid, in which case RFC 6578 requires falling back
  to full sync.
- Timezone data embedded in VTIMEZONE blocks is often nonstandard on
  Apple-originated data.

---

## 5. Comparison summary

| Aspect        | Google Calendar                                                      | Microsoft Graph                                                   | iCloud / CalDAV                                        |
| ------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| List endpoint | `GET /calendar/v3/calendars/{id}/events`                             | `GET /me/calendar/events`, `calendarView`                         | `REPORT calendar-query` on collection URL              |
| Auth/scopes   | OAuth2; `calendar.readonly` / `calendar.events.readonly` recommended | OAuth2 (Entra ID); `Calendars.Read` least privilege for full data | No OAuth; app-specific password (Basic), full access   |
| Incremental   | `syncToken` on `events.list`; whole-calendar, unbounded              | `$deltatoken` on `calendarView/delta`; range-bound in v1.0        | RFC 6578 `sync-collection` token or ctag/etag polling  |
| Deletions     | tombstones forced into sync results (`cancelled`)                    | removed items with reason in delta                                | 404 entries in sync-collection response                |
| Token expiry  | 410 GONE → full re-sync                                              | 410 Gone → full re-sync                                           | invalid token → full re-sync                           |
| Push          | watch channels (webhook, must renew)                                 | Graph subscriptions (webhook, short lifetime, must renew)         | none — polling only                                    |
| Pagination    | `pageToken`/`nextPageToken`, max 2500/page                           | `@odata.nextLink`/`$skipToken`, `$top`                            | depth/address-data paging is manual (multiget batches) |

## 6. Recommendations for KTB

1. **Two-tier design**: OAuth-first providers (Google, Microsoft) behind a
   token-vaulted connection with incremental sync; CalDAV (iCloud, generic)
   as a lower-security-tier integration with explicit UX warnings about
   full-access app passwords.
2. **Continuous sync, not one-shot import**, as the primary mode: persist
   per-calendar sync state (`syncToken` / `$deltatoken` / CalDAV sync-token)
   atomically with the projected events; handle 410/invalid-token by wiping
   and re-syncing — all three providers share this failure mode.
3. Register **webhooks where available** (Google watch, Graph subscriptions)
   as _triggers_ for delta rounds, not as data sources; build a renewal job —
   both providers expire channels/subscriptions in days.
4. For Graph, define the product's sync window (e.g. −3/+12 months) up front,
   since v1.0 delta is calendar-view-bound.
5. Expand recurrences server-side into instances when projecting into our
   ledger, since provider-native forms differ: Google can expand for you
   (`singleEvents=true`) but only outside syncToken mode; Graph expands in
   `calendarView`; CalDAV never expands.
6. Scope minimization: request `calendar.events.readonly`/`calendar.readonly`
   (Google) and `Calendars.Read` (Graph) — avoid write scopes for an import
   feature; factor in Google's restricted-scope verification early.

## Sources

- Google events.list: <https://developers.google.com/workspace/calendar/api/v3/reference/events/list>
- Google sync guide: <https://developers.google.com/workspace/calendar/api/guides/sync>
- Google push notifications: <https://developers.google.com/workspace/calendar/api/guides/push>
- Google watch: <https://developers.google.com/workspace/calendar/api/v3/reference/events/watch>
- Google quotas: <https://developers.google.com/workspace/calendar/api/guides/quota>
- Google auth/scopes: <https://developers.google.com/workspace/calendar/api/auth>
- Google restricted scopes: <https://support.google.com/cloud/answer/10311615>
- Graph list events: <https://learn.microsoft.com/en-us/graph/api/calendar-list-events?view=graph-rest-1.0>
- Graph calendarView: <https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0>
- Graph delta events: <https://learn.microsoft.com/en-us/graph/delta-query-events>
- Graph delta overview: <https://learn.microsoft.com/en-us/graph/delta-query-overview>
- Graph calendar delta: <https://learn.microsoft.com/en-us/graph/api/calendar-delta?view=graph-rest-1.0>
- Graph paging: <https://learn.microsoft.com/en-us/graph/paging>
- Graph throttling: <https://learn.microsoft.com/en-us/graph/throttling>
- Graph permissions: <https://learn.microsoft.com/en-us/graph/permissions-reference>
- Graph subscriptions: <https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0>
- Graph webhooks: <https://learn.microsoft.com/en-us/graph/webhooks>
- Apple app-specific passwords: <https://support.apple.com/en-us/102654>
- Apple EventKit (on-device only): <https://developer.apple.com/documentation/eventkit>
- RFC 4791 CalDAV: <https://www.rfc-editor.org/rfc/rfc4791>
- RFC 6578 WebDAV sync: <https://www.rfc-editor.org/rfc/rfc6578>
- RFC 5785 well-known URIs: <https://www.rfc-editor.org/rfc/rfc5785>
