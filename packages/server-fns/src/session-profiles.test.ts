import { afterEach, describe, expect, it, vi } from "vitest";

const cookies = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }));
vi.mock("@tanstack/react-start/server", () => ({
	setCookie: cookies.set,
	deleteCookie: cookies.delete,
}));

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import {
	Auth,
	DoctorProfiles,
	PatientProfiles,
	type DoctorProfile,
	type PatientProfile,
} from "@ktb/auth";
import { sessionContextLookups, tagged } from "@ktb/observability/metrics";

import {
	ensureDoctorUser,
	getDoctorAccess,
	getDoctorContext,
	getDoctorUser,
	getPatientContext,
	getSessionAccount,
	resetServerRuntime,
	setDoctorSelection,
	setPatientSelection,
	setServerRuntime,
} from "./index.ts";

const sec = { id: "sec", email: "sec@ktb.test", name: "Sec" };
const doc = { id: "doc", email: "doc@ktb.test", name: "Doc" };
const own: DoctorProfile = {
	doctorId: 3,
	userId: "doc",
	email: "doc@ktb.test",
	displayName: "Doc",
	role: "owner",
};
const delegated: DoctorProfile = {
	doctorId: 7,
	userId: "doc",
	email: "doc@ktb.test",
	displayName: "Dra",
	role: "secretary",
};
const delegated2: DoctorProfile = {
	doctorId: 9,
	userId: "doc9",
	email: "doc9@ktb.test",
	displayName: "Dr9",
	role: "secretary",
};
const sec2 = { id: "sec2", email: "sec2@ktb.test", name: "Sec2" };
const self = { ...sec, actorId: "sec", doctor: { name: "Sec", email: "sec@ktb.test" } };
const asDoctor = {
	id: "doc",
	email: "sec@ktb.test",
	name: "Sec",
	actorId: "sec",
	doctor: { name: "Dra", email: "doc@ktb.test" },
};
const me: PatientProfile = { patientId: 1, name: "Ana", relation: "self" };
const kid: PatientProfile = { patientId: 2, name: "Leo", relation: "guardian" };

/** Doctor-directory lookups performed, by user id — proves when no
 * lookup happens. Patient-directory reads are tracked separately in
 * `patientLookups`: `getSessionAccount` legitimately reads both. */
let lookups: string[] = [];
let patientLookups: string[] = [];
/** Invite claims performed, by user id. */
let claims: string[] = [];
/** Patient link syncs performed, by user id. */
let syncs: string[] = [];
/** When set, Auth.getSession throws it — proves rejected lookups are
 * evicted and retried. */
let authError: unknown;
/** When set, DoctorProfiles.listFor delegates to it — tests use it to
 * pend or fail a single directory read while later reads succeed. */
let doctorListHook:
	| ((userId: string) => Effect.Effect<readonly DoctorProfile[]>)
	| undefined;

const AuthStub = (user: typeof sec | null) =>
	Layer.succeed(
		Auth,
		Auth.of({
			getSession: async () => {
				if (authError !== undefined) throw authError;
				return user === null ? null : { user, sessionId: "s1", expiresAt: new Date(0) };
			},
			setUserBanned: async () => {},
			updateUser: async () => ({ ok: true as const }),
			deleteUser: async () => {},
		}),
	);

const DirectoriesStub = Layer.mergeAll(
	Layer.succeed(DoctorProfiles, {
		listFor: (userId) =>
			Effect.suspend(() => {
				if (doctorListHook !== undefined) return doctorListHook(userId);
				return Effect.sync(() => {
					lookups.push(userId);
					return userId === "sec"
						? [delegated]
						: userId === "sec2"
							? [delegated, delegated2]
							: userId === "doc"
								? [own]
								: [];
				});
			}),
		claimInvites: (userId) =>
			Effect.sync(() => {
				claims.push(userId);
				return 0;
			}),
	}),
	Layer.succeed(PatientProfiles, {
		listFor: (userId) =>
			Effect.sync(() => {
				patientLookups.push(userId);
				return userId === "sec" ? [me, kid] : [];
			}),
		syncLinks: (userId) =>
			Effect.sync(() => {
				syncs.push(userId);
				return 0;
			}),
	}),
);

const boot = (layer: Layer.Layer<never>) => {
	lookups = [];
	patientLookups = [];
	claims = [];
	syncs = [];
	authError = undefined;
	doctorListHook = undefined;
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
		Effect.runPromise(Effect.provide(effect as Effect.Effect<A, E, never>, layer));
	setServerRuntime({
		run,
		runAs: (_user, effect) => run(effect),
		getLocale: () => "en",
		audioTranscribeModel: "test-model",
	});
};
const signedIn = (user: typeof sec | null = sec) =>
	boot(Layer.mergeAll(AuthStub(user), DirectoriesStub) as Layer.Layer<never>);

const cookie = (value: string) => new Headers({ cookie: value });

afterEach(() => resetServerRuntime());

describe("getDoctorUser", () => {
	it("is null for anonymous requests", async () => {
		signedIn(null);
		expect(await getDoctorUser(cookie("ktb_doctor=7"))).toBeNull();
		await expect(ensureDoctorUser(new Headers())).rejects.toMatchObject({
			message: "unauthenticated",
			status: 401,
		});
	});

	it("acts as the only delegated doctor without a selector", async () => {
		signedIn();
		expect(await getDoctorUser(new Headers())).toEqual(asDoctor);
	});

	it("acts as the first delegated doctor when several are held and none selected", async () => {
		signedIn(sec2);
		expect(await getDoctorUser(new Headers())).toEqual({
			...asDoctor,
			email: "sec2@ktb.test",
			name: "Sec2",
			actorId: "sec2",
		});
	});

	it("lets a multi-delegation account act as the selected doctor", async () => {
		signedIn(sec2);
		expect(await getDoctorUser(cookie("ktb_doctor=9"))).toEqual({
			id: "doc9",
			email: "sec2@ktb.test",
			name: "Sec2",
			actorId: "sec2",
			doctor: { name: "Dr9", email: "doc9@ktb.test" },
		});
	});

	it("acts as the selected doctor when the directory confirms the delegation", async () => {
		signedIn();
		expect(await ensureDoctorUser(cookie("ktb_doctor=7"))).toEqual(asDoctor);
		expect(lookups).toEqual(["sec"]);
	});

	it("ignores a selector pointing at a profile the user does not hold", async () => {
		signedIn();
		expect(await getDoctorUser(cookie("ktb_doctor=99"))).toEqual(asDoctor);
	});

	it("is null — and 403 when required — for an account with no doctor profile", async () => {
		signedIn({ id: "nobody", email: "nobody@ktb.test", name: "Nobody" });
		expect(await getDoctorUser(cookie("ktb_doctor=7"))).toBeNull();
		await expect(ensureDoctorUser(cookie("ktb_doctor=7"))).rejects.toMatchObject({
			name: "NotADoctorError",
			message: "forbidden",
			status: 403,
		});
	});

	it("acts as the signed-in user when no directory is deployed", async () => {
		boot(AuthStub(sec) as Layer.Layer<never>);
		expect(await getDoctorUser(cookie("ktb_doctor=7"))).toEqual(self);
	});
});

describe("getDoctorAccess", () => {
	it("tells anonymous visitors, non-doctors and doctors apart", async () => {
		signedIn(null);
		expect(await getDoctorAccess(new Headers())).toBe("anonymous");
		signedIn({ id: "nobody", email: "nobody@ktb.test", name: "Nobody" });
		expect(await getDoctorAccess(new Headers())).toBe("no-doctor");
		signedIn();
		expect(await getDoctorAccess(new Headers())).toBe("doctor");
	});
});

describe("getSessionAccount", () => {
	it("is null for anonymous requests", async () => {
		signedIn(null);
		expect(await getSessionAccount(new Headers())).toBeNull();
	});

	it("marks an account with no doctor profile as patient-only with no clinical role", async () => {
		const nobody = { id: "nobody", email: "nobody@ktb.test", name: "Nobody" };
		signedIn(nobody);
		expect(await getSessionAccount(new Headers())).toEqual({
			...nobody,
			patientOnly: true,
			clinicalRole: null,
			doctorProfiles: 0,
			patientProfiles: 0,
		});
	});

	it("marks own and delegated profiles as owner and secretary, without claiming invites", async () => {
		signedIn(doc);
		expect(await getSessionAccount(new Headers())).toEqual({
			...doc,
			patientOnly: false,
			clinicalRole: "owner",
			doctorProfiles: 1,
			patientProfiles: 0,
		});
		signedIn();
		expect(await getSessionAccount(new Headers())).toEqual({
			...sec,
			patientOnly: false,
			clinicalRole: "secretary",
			doctorProfiles: 1,
			patientProfiles: 2,
		});
		expect(claims).toEqual([]);
	});

	it("counts every directory entry — own profile plus delegations", async () => {
		signedIn(sec2);
		expect((await getSessionAccount(new Headers()))?.doctorProfiles).toBe(2);
	});

	it("counts the account's linked patient records without syncing links", async () => {
		signedIn();
		expect((await getSessionAccount(new Headers()))?.patientProfiles).toBe(2);
		expect(syncs).toEqual([]);
	});

	it("is never patient-only and always owner when no directory is deployed", async () => {
		boot(AuthStub(sec) as Layer.Layer<never>);
		expect(await getSessionAccount(new Headers())).toEqual({
			...sec,
			patientOnly: false,
			clinicalRole: "owner",
			doctorProfiles: 0,
			patientProfiles: 0,
		});
	});
});

describe("getDoctorContext", () => {
	it("is null for anonymous requests", async () => {
		signedIn(null);
		expect(await getDoctorContext(new Headers())).toBeNull();
	});

	it("lists the profiles and the active one without claiming invites", async () => {
		signedIn();
		expect(await getDoctorContext(new Headers())).toEqual({
			user: sec,
			profiles: [delegated],
			active: delegated,
		});
		expect(claims).toEqual([]);
	});

	it("claims invites first on entry points", async () => {
		signedIn();
		await getDoctorContext(new Headers(), { claimInvites: true });
		expect(claims).toEqual(["sec"]);
	});

	it("has no profiles when no directory is deployed", async () => {
		boot(AuthStub(sec) as Layer.Layer<never>);
		expect(await getDoctorContext(new Headers(), { claimInvites: true })).toEqual({
			user: sec,
			profiles: [],
			active: null,
		});
	});

	it("shares one directory lookup across helpers for the same request", async () => {
		signedIn();
		const headers = new Headers();
		await getDoctorContext(headers);
		await getDoctorUser(headers);
		await getSessionAccount(headers);
		// One doctor-directory read shared by all three helpers;
		// getSessionAccount additionally reads the patient directory
		// once for its patientProfiles count.
		expect(lookups).toEqual(["sec"]);
		expect(patientLookups).toEqual(["sec"]);
	});

	it("claimInvites bypasses the cached pre-claim read and refreshes it", async () => {
		signedIn();
		const headers = new Headers();
		await getDoctorContext(headers);
		expect(lookups).toEqual(["sec"]);
		await getDoctorContext(headers, { claimInvites: true });
		expect(claims).toEqual(["sec"]);
		expect(lookups).toEqual(["sec", "sec"]);
		// The stored post-claim result serves later non-claim reads.
		await getDoctorContext(headers);
		expect(lookups).toEqual(["sec", "sec"]);
	});

	it("does not let a stale rejection evict a newer cache entry", async () => {
		signedIn();
		let doctorListCalls = 0;
		let rejectFirst: ((error: unknown) => void) | undefined;
		doctorListHook = () =>
			Effect.suspend(() => {
				doctorListCalls += 1;
				if (doctorListCalls === 1) {
					return Effect.promise(
						() =>
							new Promise<readonly DoctorProfile[]>((_, reject) => {
								rejectFirst = reject;
							}),
					);
				}
				return Effect.succeed([delegated]);
			});
		const headers = new Headers();
		try {
			// The non-claim read pends on its directory call; the claim read
			// bypasses the cache, succeeds and stores the newer entry.
			const stale = getDoctorContext(headers);
			await vi.waitFor(() => {
				expect(doctorListCalls).toBe(1);
			});
			const fresh = getDoctorContext(headers, { claimInvites: true });
			await fresh;
			expect(doctorListCalls).toBe(2);
			// The stale read now rejects — it must not evict the entry the
			// successful claim read stored under the same Headers key.
			rejectFirst?.(new Error("stale directory failure"));
			await expect(stale).rejects.toThrow("stale directory failure");
			await expect(getDoctorContext(headers)).resolves.toMatchObject({
				profiles: [delegated],
			});
			expect(doctorListCalls).toBe(2);
		} finally {
			doctorListHook = undefined;
		}
	});
});

describe("setDoctorSelection", () => {
	it("stores the chosen profile in a long-lived selector cookie", async () => {
		await setDoctorSelection(7);
		expect(cookies.set).toHaveBeenCalledWith("ktb_doctor", "7", {
			path: "/",
			httpOnly: true,
			sameSite: "lax",
			secure: true,
			maxAge: 31536000,
		});
	});

	it("clears the selection", async () => {
		await setDoctorSelection(null);
		expect(cookies.delete).toHaveBeenCalledWith("ktb_doctor", { path: "/" });
	});
});

describe("setPatientSelection", () => {
	it("stores and clears the portal profile selector", async () => {
		await setPatientSelection(4);
		expect(cookies.set).toHaveBeenCalledWith(
			"ktb_patient",
			"4",
			expect.objectContaining({ httpOnly: true, path: "/" }),
		);
		await setPatientSelection(null);
		expect(cookies.delete).toHaveBeenCalledWith("ktb_patient", { path: "/" });
	});
});

describe("getPatientContext", () => {
	it("is null for anonymous requests", async () => {
		signedIn(null);
		expect(await getPatientContext(new Headers())).toBeNull();
	});

	it("opens the selected profile among the user's own", async () => {
		signedIn();
		expect(await getPatientContext(cookie("ktb_patient=2"))).toEqual({
			user: sec,
			profiles: [me, kid],
			active: kid,
		});
	});

	it("syncs links first on entry points only", async () => {
		signedIn();
		await getPatientContext(new Headers());
		expect(syncs).toEqual([]);
		await getPatientContext(new Headers(), { syncLinks: true });
		expect(syncs).toEqual(["sec"]);
	});

	it("selects nothing for a record the user holds no access to", async () => {
		signedIn();
		const context = await getPatientContext(cookie("ktb_patient=99"));
		expect(context?.active).toBeNull();
		expect(context?.profiles).toEqual([me, kid]);
	});

	it("has no profiles when no directory is deployed", async () => {
		boot(AuthStub(sec) as Layer.Layer<never>);
		expect(await getPatientContext(cookie("ktb_patient=1"), { syncLinks: true })).toEqual({
			user: sec,
			profiles: [],
			active: null,
		});
	});

	it("shares one directory lookup across calls for the same request", async () => {
		signedIn();
		const headers = new Headers();
		await getPatientContext(headers);
		await getPatientContext(headers);
		expect(patientLookups).toEqual(["sec"]);
	});

	it("syncLinks bypasses the cached read and refreshes it", async () => {
		signedIn();
		const headers = new Headers();
		await getPatientContext(headers);
		await getPatientContext(headers, { syncLinks: true });
		expect(syncs).toEqual(["sec"]);
		expect(patientLookups).toEqual(["sec", "sec"]);
		// The stored post-sync result serves later non-sync reads.
		await getPatientContext(headers);
		expect(patientLookups).toEqual(["sec", "sec"]);
	});

	it("does not let a stale rejection evict the newer cache entry", async () => {
		signedIn();
		authError = new Error("auth db down");
		const headers = new Headers();
		// The claimInvites call bypasses the read and replaces the pending
		// non-claim entry; both reject on the shared session lookup. The
		// stale rejection must not delete the newer entry — but the newer
		// one rejects too, so its own eviction still applies.
		const stale = getDoctorContext(headers);
		const fresh = getDoctorContext(headers, { claimInvites: true });
		await expect(stale).rejects.toThrow("auth db down");
		await expect(fresh).rejects.toThrow("auth db down");
		authError = undefined;
		// Both entries were evicted: the next call retries and succeeds.
		await expect(getDoctorContext(headers)).resolves.toMatchObject({
			profiles: [delegated],
		});
		expect(lookups).toEqual(["sec"]);
	});
});

describe("session context telemetry", () => {
	const lookupCount = (context: string, result: string) =>
		Effect.runPromise(Metric.value(tagged(sessionContextLookups, { context, result }))).then(
			(state) => ("count" in state ? state.count : 0),
		);

	it("counts doctor-context loads under the doctor label", async () => {
		signedIn();
		const headers = new Headers();
		const before = await lookupCount("doctor", "load");
		await getDoctorContext(headers);
		expect(await lookupCount("doctor", "load")).toBe(before + 1);
	});

	it("counts patient-context loads under the patient label", async () => {
		signedIn();
		const headers = new Headers();
		const before = await lookupCount("patient", "load");
		await getPatientContext(headers);
		expect(await lookupCount("patient", "load")).toBe(before + 1);
	});
});
