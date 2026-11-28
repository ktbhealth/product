import { Effect } from "effect";

import { Calendars } from "@ktb/calendar";
import { createPluginApiRoute, getDoctorUser, runAs } from "@ktb/server-fns";

import { CalendarIntegrations } from "../calendar.ts";
import { CALENDAR_OAUTH_STATE_COOKIE, calendarOAuthStateOwner } from "./calendar.google.connect.ts";

const cookieValue = (headers: Headers, name: string): string | null => {
	for (const pair of (headers.get("cookie") ?? "").split(";")) {
		const eq = pair.indexOf("=");
		if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
		return pair.slice(eq + 1).trim();
	}
	return null;
};

const agendaRedirect = (query: string) =>
	new Response(null, {
		status: 302,
		headers: {
			location: `/portal/doctor/agenda?${query}`,
			"set-cookie": `${CALENDAR_OAUTH_STATE_COOKIE}=; Path=/api/calendar; HttpOnly; SameSite=Lax; Max-Age=0`,
			"cache-control": "no-store",
		},
	});

/** OAuth callback edge: exchanges the provider code at the adapter edge,
 * then hands opaque credentials to the domain service, which seals them
 * in the user-scoped vault slot and records the connection row. */
export const Route = createPluginApiRoute("agenda.routes")("/api/calendar/google/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const user = await getDoctorUser(request.headers);
				if (user === null) return agendaRedirect("calendarImport=unauthorized");
				if (url.searchParams.get("error") !== null) return agendaRedirect("calendarImport=denied");
				const state = url.searchParams.get("state");
				const code = url.searchParams.get("code");
				if (
					state === null ||
					code === null ||
					cookieValue(request.headers, CALENDAR_OAUTH_STATE_COOKIE) !== state ||
					calendarOAuthStateOwner(state) !== user.id
				) {
					return agendaRedirect("calendarImport=invalid-state");
				}
				const connected = await runAs(
					user,
					Effect.gen(function* () {
						const calendars = yield* Calendars;
						const oauth = calendars.provider("google")?.oauth;
						if (oauth === undefined) return false;
						const credentials = yield* Effect.tryPromise(() => oauth.exchangeCode(code));
						const integrations = yield* CalendarIntegrations;
						yield* integrations.completeOAuth(user.id, {
							provider: "google",
							calendarId: "primary",
							credentials,
						});
						return true;
					}),
				).catch((err) => {
					console.error("[calendar-callback] oauth completion failed:", err);
					return false;
				});
				return agendaRedirect(connected ? "calendarImport=connected" : "calendarImport=failed");
			},
		},
	},
});
