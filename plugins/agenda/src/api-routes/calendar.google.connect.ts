import { Effect } from "effect";

import { Calendars } from "@ktb/calendar";
import { createPluginApiRoute, getDoctorUser, runAs } from "@ktb/server-fns";

export const CALENDAR_OAUTH_STATE_COOKIE = "ktb_calendar_oauth_state";

const randomState = (ownerId: string): string => {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${nonce}.${encodeURIComponent(ownerId)}`;
};

/** The acting doctor encoded into a state value, or null when absent. */
export const calendarOAuthStateOwner = (state: string): string | null => {
	const separator = state.indexOf(".");
	if (separator === -1) return null;
	try {
		return decodeURIComponent(state.slice(separator + 1));
	} catch {
		return null;
	}
};

/** Starts the Google OAuth connection dance. The state cookie is the
 * CSRF token itself: callback accepts only the exact value this response
 * set, and it never carries token material. */
export const Route = createPluginApiRoute("agenda.routes")("/api/calendar/google/connect")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const user = await getDoctorUser(request.headers);
				if (user === null) return Response.json({ error: "unauthorized" }, { status: 401 });
				const authorization = await runAs(
					user,
					Effect.gen(function* () {
						const calendars = yield* Calendars;
						const provider = calendars.provider("google");
						if (provider?.oauth === undefined) return null;
						const state = randomState(user.id);
						return { state, url: provider.oauth.authorizationUrl({ state }) };
					}),
				).catch(() => null);
				if (authorization === null) {
					return new Response(null, {
						status: 302,
						headers: { location: "/portal/doctor/agenda?calendarImport=calendar-unavailable" },
					});
				}
				const secure = new URL(request.url).protocol === "https:";
				return new Response(null, {
					status: 302,
					headers: {
						location: authorization.url,
						"set-cookie": `${CALENDAR_OAUTH_STATE_COOKIE}=${authorization.state}; Path=/api/calendar; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
						"cache-control": "no-store",
					},
				});
			},
		},
	},
});
