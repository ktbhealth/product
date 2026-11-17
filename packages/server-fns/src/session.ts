import {
	actingAs,
	Auth,
	DOCTOR_PROFILE_COOKIE,
	DoctorProfiles,
	PATIENT_PROFILE_COOKIE,
	PatientProfiles,
	profileIdFromHeaders,
	resolveDoctorProfile,
	resolvePatientProfile,
} from "@ktb/auth";
import type { ActingUser, DoctorProfile, PatientProfile, SessionUser } from "@ktb/auth";
import { tenantSelectorFromHeaders, type TenantSelector } from "@ktb/tenant/selector";
import {
	recordUnsafe,
	sessionContextLoadDuration,
	sessionContextLookups,
	tagged,
} from "@ktb/observability/metrics";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { run } from "./runtime.ts";

export type { ActingUser, DoctorProfile, PatientProfile, SessionUser };

/**
 * Thrown by `ensureSessionUser` when no session exists. The `status`
 * field is read by TanStack Start's error serializer
 * (`getErrorStatus` → `error.status`), so server-fn callers get a real
 * 401 instead of a generic 500. Keep the message stable — callers and
 * tests match on "unauthenticated".
 */
export class UnauthenticatedError extends Error {
	readonly status = 401;
	constructor() {
		super("unauthenticated");
		this.name = "UnauthenticatedError";
	}
}

/**
 * Session helpers for plugin server functions — the same contract the
 * host's `lib/auth.ts` wrappers had, reached through the runtime
 * registry instead of the app's platform module (P-033).
 */
// Lazy: `@tanstack/react-start/server` is server-only and its graph
// reaches react-dom/server (CJS). This module is reachable from client
// bundles through plugin index files, so a static import would break
// hydration; the dynamic import only resolves where it is invoked.
const requestHeadersOr = async (headers?: Headers): Promise<Headers> =>
	headers ?? (await import("@tanstack/react-start/server")).getRequestHeaders();

/**
 * Per-request memoization. Every helper in this module is invoked with
 * the same `Headers` object within one request (explicitly, or the
 * stable `getRequestHeaders()` result for the implicit path), so it is
 * a natural WeakMap key: the session and directory lookups are shared
 * across `getSessionUser`/`getDoctorUser`/`ensureDoctorUser`/… calls in
 * one request and can never leak into the next — keys are collected
 * with the request. Rejections are evicted so a failed lookup is
 * retried by the next call instead of caching the failure.
 */
const sessionUserCache = new WeakMap<Headers, Promise<SessionUser | null>>();

interface ResolvedDoctorContext {
	readonly user: SessionUser;
	readonly profiles: readonly DoctorProfile[] | null;
	readonly selectedId: number | null;
}

const doctorContextCache = new WeakMap<Headers, Promise<ResolvedDoctorContext | null>>();

interface ResolvedPatientContext {
	readonly user: SessionUser;
	readonly profiles: readonly PatientProfile[];
	readonly selectedId: number | null;
}

const patientContextCache = new WeakMap<Headers, Promise<ResolvedPatientContext | null>>();

/** Store `promise` under `key`, evicting it if it rejects while still
 * current (a later call may already have replaced the entry). */
const cacheLookup = <K extends object, V>(
	cache: WeakMap<K, Promise<V>>,
	key: K,
	promise: Promise<V>,
): Promise<V> => {
	cache.set(key, promise);
	void promise.catch(() => {
		if (cache.get(key) === promise) cache.delete(key);
	});
	return promise;
};

/** Which resolution a lookup serves — the `context` label on
 * `ktb_session_context_lookups_total` / `ktb_session_context_load_duration_ms`. */
type SessionContextKind = "session" | "doctor" | "patient";

/**
 * Memoized resolution with lookup telemetry. `result: cache` means the
 * per-request WeakMap entry served the call — no session or directory
 * I/O; `result: load` means the backing lookup ran and its wall time is
 * recorded on `ktb_session_context_load_duration_ms{context}` (the
 * DB-cost signal the memoization exists to contain). `readCache: false`
 * preserves the claimInvites/syncLinks contract — the mutation path
 * always loads fresh but still stores its result for later reads in the
 * same request. Memoization semantics are unchanged.
 */
const memoized = async <V>(
	cache: WeakMap<Headers, Promise<V>>,
	requestHeaders: Headers,
	context: SessionContextKind,
	readCache: boolean,
	load: () => Promise<V>,
): Promise<V> => {
	const cached = readCache ? cache.get(requestHeaders) : undefined;
	if (cached !== undefined) {
		recordUnsafe(tagged(sessionContextLookups, { context, result: "cache" }), 1);
		return cached;
	}
	recordUnsafe(tagged(sessionContextLookups, { context, result: "load" }), 1);
	const started = Date.now();
	try {
		return await cacheLookup(cache, requestHeaders, load());
	} finally {
		recordUnsafe(tagged(sessionContextLoadDuration, { context }), Date.now() - started);
	}
};

async function loadSessionUser(requestHeaders: Headers): Promise<SessionUser | null> {
	const session = await run(
		Effect.gen(function* () {
			const auth = yield* Auth;
			// Auth.getSession is a Promise port; the span wraps the Effect
			// boundary where it is invoked. null session is normal — no logging.
			return yield* Effect.withSpan(
				Effect.promise(() => auth.getSession(requestHeaders)),
				"Auth.getSession",
			);
		}),
	);
	if (!session) return null;
	return session.user;
}

export async function getSessionUser(headers?: Headers): Promise<SessionUser | null> {
	const requestHeaders = await requestHeadersOr(headers);
	return memoized(sessionUserCache, requestHeaders, "session", true, () =>
		loadSessionUser(requestHeaders),
	);
}

export async function ensureSessionUser(headers?: Headers): Promise<SessionUser> {
	const user = await getSessionUser(headers);
	if (!user) throw new UnauthenticatedError();
	return user;
}

/**
 * Thrown by `ensureDoctorUser` when the session user holds no doctor
 * profile to act as — a signed-in account that is not (yet) a doctor
 * nor anyone's secretary. `status` drives the serialized HTTP status.
 */
export class NotADoctorError extends Error {
	readonly status = 403;
	constructor() {
		super("forbidden");
		this.name = "NotADoctorError";
	}
}

/** Doctor-side context of a request: the signed-in user, every doctor
 * profile they may act as, and the one this request acts as. */
export interface DoctorContext {
	readonly user: SessionUser;
	readonly profiles: readonly DoctorProfile[];
	/** Null when the user holds no profile at all. */
	readonly active: DoctorProfile | null;
}

/**
 * Resolve the doctor-side context. The `ktb_doctor` selector cookie
 * picks among the profiles the `DoctorProfiles` directory returns for
 * the user; the directory is re-read on every request, so a revoked
 * delegation or a forged cookie selects nothing it should not.
 *
 * `claimInvites` first activates invites addressed to the user's
 * verified email — pass it on entry points (post-login, the profile
 * chooser), not on every request.
 *
 * Returns `profiles: null` when no directory is deployed: a single-role
 * app where every account acts for itself.
 */
async function loadDoctorContext(
	requestHeaders: Headers,
	claimInvites: boolean,
): Promise<ResolvedDoctorContext | null> {
	const user = await getSessionUser(requestHeaders);
	if (!user) return null;
	const profiles = await run(
		Effect.gen(function* () {
			const directory = yield* Effect.serviceOption(DoctorProfiles);
			if (Option.isNone(directory)) return null;
			if (claimInvites) yield* directory.value.claimInvites(user.id);
			return yield* directory.value.listFor(user.id);
		}),
	);
	return {
		user,
		profiles,
		selectedId: profileIdFromHeaders(requestHeaders, DOCTOR_PROFILE_COOKIE),
	};
}

async function resolveDoctorContext(
	headers: Headers | undefined,
	claimInvites: boolean,
): Promise<ResolvedDoctorContext | null> {
	const requestHeaders = await requestHeadersOr(headers);
	// `claimInvites` mutates invite state, so it must never be served a
	// pre-claim cache entry — it always runs fresh. Its result IS stored:
	// post-claim profiles are the newest truth, and later non-claim reads
	// in the same request should see the just-claimed invites.
	return memoized(doctorContextCache, requestHeaders, "doctor", !claimInvites, () =>
		loadDoctorContext(requestHeaders, claimInvites),
	);
}

export async function getDoctorContext(
	headers?: Headers,
	options?: { readonly claimInvites?: boolean },
): Promise<DoctorContext | null> {
	const resolved = await resolveDoctorContext(headers, options?.claimInvites === true);
	if (!resolved) return null;
	const profiles = resolved.profiles ?? [];
	return {
		user: resolved.user,
		profiles,
		active: resolveDoctorProfile(profiles, resolved.selectedId),
	};
}

/**
 * The user this request acts as on the doctor side — what doctor-scoped
 * server fns pass to `runAs` and to owner parameters instead of the raw
 * session user. Null for anonymous requests *and* for signed-in accounts
 * with no doctor profile to act as (see {@link getDoctorContext}), so
 * doctor data paths treat both as "nothing visible".
 */
export async function getDoctorUser(headers?: Headers): Promise<ActingUser | null> {
	const resolved = await resolveDoctorContext(headers, false);
	if (!resolved) return null;
	if (resolved.profiles === null) return actingAs(resolved.user, null);
	const active = resolveDoctorProfile(resolved.profiles, resolved.selectedId);
	return active === null ? null : actingAs(resolved.user, active);
}

/** The signed-in user as the app chrome sees them. */
export interface SessionAccount extends SessionUser {
	/**
	 * True when the account has no doctor side at all — no doctor profile
	 * of its own and none delegated to it: a patient account, which is
	 * shown the patient portal only. False when no directory is deployed
	 * (a single-role app where every account acts for itself).
	 */
	readonly patientOnly: boolean;
	/**
	 * The account's clinical standing: "owner" when it holds its own
	 * doctor profile (or no directory is deployed — every account acts
	 * for itself), "secretary" when it only acts through delegations,
	 * null when it has no doctor side at all (a patient-only account).
	 */
	readonly clinicalRole: "owner" | "secretary" | null;
	/**
	 * Number of entries in the account's doctor-profile directory — its
	 * own profile plus delegations. 0 for a patient-only account and
	 * when no directory is deployed (a single-role app has nothing to
	 * switch between either). Chrome uses it to gate multi-profile
	 * affordances like the profile chooser.
	 */
	readonly doctorProfiles: number;
	/**
	 * Number of patient records linked to the account — how many profiles
	 * the patient portal would offer. 0 when the account holds no patient
	 * access and when no patient directory is deployed (an app without a
	 * patient portal). Chrome uses it to hide the patient-portal entry —
	 * the link only makes sense when there is a record to open.
	 */
	readonly patientProfiles: number;
}

/** The session user plus which side of the app the account belongs to
 * — what the root layout renders its navigation from. Null when
 * anonymous. */
export async function getSessionAccount(headers?: Headers): Promise<SessionAccount | null> {
	const requestHeaders = await requestHeadersOr(headers);
	const resolved = await resolveDoctorContext(requestHeaders, false);
	if (!resolved) return null;
	const profiles = resolved.profiles;
	// Read-only on purpose: invites/links are claimed on entry points
	// (sign-up, the portal home), not on every request that renders
	// chrome. Goes through getPatientContext so the per-request
	// patient-context cache is shared with the portal path — the
	// directory is read at most once per request either way.
	const patient = await getPatientContext(requestHeaders);
	// Non-null: a resolved doctor context implies a session user, and the
	// patient context resolves from the same memoized session — only its
	// directory may be absent (profiles: []).
	const patientProfiles = patient!.profiles.length;
	return {
		...resolved.user,
		patientOnly: profiles !== null && profiles.length === 0,
		clinicalRole:
			profiles === null || profiles.some((p) => p.role === "owner")
				? "owner"
				: profiles.length === 0
					? null
					: "secretary",
		doctorProfiles: profiles === null ? 0 : profiles.length,
		patientProfiles,
	};
}

/** Where a request stands on the doctor side — what route guards branch on. */
export type DoctorAccess = "anonymous" | "no-doctor" | "doctor";

/** "anonymous" without a session, "no-doctor" for a signed-in account
 * with no doctor profile to act as, "doctor" otherwise. */
export async function getDoctorAccess(headers?: Headers): Promise<DoctorAccess> {
	const requestHeaders = await requestHeadersOr(headers);
	if (await getDoctorUser(requestHeaders)) return "doctor";
	return (await getSessionUser(requestHeaders)) ? "no-doctor" : "anonymous";
}

/** Like {@link getDoctorUser}, failing 401 without a session and 403
 * for a signed-in account with no doctor profile to act as. */
export async function ensureDoctorUser(headers?: Headers): Promise<ActingUser> {
	const requestHeaders = await requestHeadersOr(headers);
	const acting = await getDoctorUser(requestHeaders);
	if (acting) return acting;
	if (await getSessionUser(requestHeaders)) throw new NotADoctorError();
	throw new UnauthenticatedError();
}

/** Selection cookies outlive the session cookie on purpose: they only
 * remember a preference and grant nothing without a valid session. */
const SELECTION_COOKIE = {
	path: "/",
	httpOnly: true,
	sameSite: "lax",
	secure: true,
	maxAge: 60 * 60 * 24 * 365,
} as const;

/**
 * Persist (or clear, with null) the doctor profile this browser acts
 * as. The cookie is a selector only — it grants nothing by itself, so
 * callers need not validate `doctorId` for safety, only for UX.
 */
export async function setDoctorSelection(doctorId: number | null): Promise<void> {
	const { deleteCookie, setCookie } = await import("@tanstack/react-start/server");
	if (doctorId === null) deleteCookie(DOCTOR_PROFILE_COOKIE, { path: SELECTION_COOKIE.path });
	else setCookie(DOCTOR_PROFILE_COOKIE, String(doctorId), SELECTION_COOKIE);
}

/** Persist (or clear, with null) the patient profile this browser opens
 * in the portal — a selector only, like {@link setDoctorSelection}. */
export async function setPatientSelection(patientId: number | null): Promise<void> {
	const { deleteCookie, setCookie } = await import("@tanstack/react-start/server");
	if (patientId === null) deleteCookie(PATIENT_PROFILE_COOKIE, { path: SELECTION_COOKIE.path });
	else setCookie(PATIENT_PROFILE_COOKIE, String(patientId), SELECTION_COOKIE);
}

/** Patient-portal context of a request: the signed-in user, every
 * patient record they hold active access to, and the one being opened. */
export interface PatientContext {
	readonly user: SessionUser;
	readonly profiles: readonly PatientProfile[];
	/** Null when nothing is linked yet or a choice is still needed. */
	readonly active: PatientProfile | null;
}

/**
 * Resolve the patient-portal context: the `ktb_patient` selector cookie
 * picks among the profiles the `PatientProfiles` directory returns for
 * the user — re-checked on every request; a cookie pointing at a record
 * the user holds no active access to selects nothing.
 *
 * `syncLinks` first claims invites — pass it on entry points (the
 * portal home), not on every request.
 */
async function loadPatientContext(
	requestHeaders: Headers,
	syncLinks: boolean,
): Promise<ResolvedPatientContext | null> {
	const user = await getSessionUser(requestHeaders);
	if (!user) return null;
	const profiles = await run(
		Effect.gen(function* () {
			// Optional: absent when the patient-access plugin is not deployed.
			const directory = yield* Effect.serviceOption(PatientProfiles);
			if (Option.isNone(directory)) return [];
			if (syncLinks) yield* directory.value.syncLinks(user.id);
			return yield* directory.value.listFor(user.id);
		}),
	);
	return {
		user,
		profiles,
		selectedId: profileIdFromHeaders(requestHeaders, PATIENT_PROFILE_COOKIE),
	};
}

export async function getPatientContext(
	headers?: Headers,
	options?: { readonly syncLinks?: boolean },
): Promise<PatientContext | null> {
	const requestHeaders = await requestHeadersOr(headers);
	// Same rule as `claimInvites` in resolveDoctorContext: `syncLinks`
	// mutates link state, so it bypasses the cache read but stores its
	// fresh post-sync result for later non-sync reads in this request.
	const syncLinks = options?.syncLinks === true;
	const resolved = await memoized(patientContextCache, requestHeaders, "patient", !syncLinks, () =>
		loadPatientContext(requestHeaders, syncLinks),
	);
	if (!resolved) return null;
	return {
		user: resolved.user,
		profiles: resolved.profiles,
		active: resolvePatientProfile(resolved.profiles, resolved.selectedId),
	};
}

/**
 * Tenant selector for the current request (P-053): reads the default
 * header transport (`x-tenant-id`/`x-tenant-slug`/`x-tenant-kind`/
 * `x-tenant`) via `tenantSelectorFromHeaders`. Pass the result as the
 * third argument to `runAs` so the composition root's TenantResolver
 * binds `Tenant` inside the request scope. Returns `null` when no
 * tenant header is present.
 */
export async function getTenantSelector(headers?: Headers): Promise<TenantSelector | null> {
	return tenantSelectorFromHeaders(await requestHeadersOr(headers));
}
