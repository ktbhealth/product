import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { eq } from "drizzle-orm";

import { ArrowLeftRightIcon } from "lucide-react";

import { DoctorDelegations, DoctorProfiles, type DoctorProfile } from "@ktb/server-fns";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { user } from "@ktb/db/schema";
import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";
import { routeContribution } from "@ktb/platform/routes";
import { portalShellPlugin } from "@ktb/portal";
import { physical } from "@tanstack/virtual-file-routes";

import { doctors, type Doctor } from "./schema.ts";
import { DoctorSelectPortalPage } from "./views/DoctorSelectPortalPage.tsx";

export type { Doctor } from "./schema.ts";

export async function getDoctorByUser(db: DbClient, userId: string): Promise<Doctor | null> {
	const rows = await db.select().from(doctors).where(eq(doctors.userId, userId));
	return rows[0] ?? null;
}

/**
 * The user's doctor profile, created on first call. Idempotent: an
 * existing profile is returned untouched — `displayName` only seeds a
 * new one.
 */
export async function ensureDoctorProfile(
	db: DbClient,
	userId: string,
	displayName: string,
): Promise<Doctor> {
	await db
		.insert(doctors)
		.values({ userId, displayName, createdAt: new Date(), updatedAt: new Date() })
		.onConflictDoNothing();
	return (await getDoctorByUser(db, userId))!;
}

/** The user's own doctor profile as a directory entry ("owner") — empty
 * for an account that is not a doctor. */
export async function listOwnDoctorProfiles(
	db: DbClient,
	userId: string,
): Promise<DoctorProfile[]> {
	const rows = await db
		.select({
			doctorId: doctors.id,
			userId: doctors.userId,
			email: user.email,
			displayName: doctors.displayName,
		})
		.from(doctors)
		.innerJoin(user, eq(doctors.userId, user.id))
		.where(eq(doctors.userId, userId));
	return rows.map((row) => ({ ...row, role: "owner" as const }));
}

/**
 * `DoctorProfiles` directory: the user's own profile first, then the
 * profiles a deployed `DoctorDelegations` source hands them. The source
 * is looked up per call, not when the layer is built, so the directory
 * never depends on the plugin that provides it.
 */
export const DoctorProfilesLive = Layer.effect(
	DoctorProfiles,
	Effect.gen(function* () {
		const db = yield* Db;
		return DoctorProfiles.of({
			listFor: Effect.fn("DoctorProfiles.listFor")(function* (userId: string) {
				const own = yield* Effect.promise(() => listOwnDoctorProfiles(db, userId));
				const source = yield* Effect.serviceOption(DoctorDelegations);
				if (Option.isNone(source)) return own;
				return [...own, ...(yield* source.value.listFor(userId))];
			}),
			claimInvites: Effect.fn("DoctorProfiles.claimInvites")(function* (userId: string) {
				const source = yield* Effect.serviceOption(DoctorDelegations);
				return Option.isNone(source) ? 0 : yield* source.value.claimInvites(userId);
			}),
		});
	}),
);

/**
 * Doctors domain port. A profile is what makes an account a doctor;
 * `ensureProfile` creates the caller's *own* profile only — it fails
 * `Forbidden` without a principal and under delegation (a secretary
 * acting for a doctor cannot mint profiles).
 */
export class Doctors extends Context.Service<
	Doctors,
	{
		readonly ensureProfile: (displayName: string) => Effect.Effect<Doctor, Forbidden>;
		/**
		 * Display name of the doctor profile `userId` owns — null for a
		 * non-doctor. Directory metadata (the portal's "kept by" / "recorded
		 * by" labels); any authenticated principal may read it.
		 */
		readonly displayName: (userId: string) => Effect.Effect<string | null, Forbidden>;
	}
>()("@ktb/doctors/Doctors") {}

export const DoctorsLive = Layer.effect(
	Doctors,
	Effect.gen(function* () {
		const db = yield* Db;
		return Doctors.of({
			ensureProfile: Effect.fn("Doctors.ensureProfile")(function* (displayName: string) {
				const principal = yield* Principal;
				if (principal === null || principal.actorId !== undefined) {
					return yield* Effect.fail(new Forbidden({ path: "doctor.create" }));
				}
				return yield* Effect.promise(() => ensureDoctorProfile(db, principal.userId, displayName));
			}),
			displayName: Effect.fn("Doctors.displayName")(function* (userId: string) {
				const principal = yield* Principal;
				if (principal === null) return yield* Effect.fail(new Forbidden({ path: "doctor.read" }));
				const row = yield* Effect.promise(() => getDoctorByUser(db, userId));
				return row?.displayName ?? null;
			}),
		});
	}),
);

export const doctorsTablesPlugin = definePlugin({
	id: "doctors.tables",
	meta: { keywords: ["doctors", "tables"] },
	tables: { doctors },
});

export const doctorsServicesPlugin = definePlugin({
	id: "doctors.services",
	meta: { keywords: ["doctors", "services"] },
	services: Layer.mergeAll(DoctorsLive, DoctorProfilesLive),
});

// Route subtree composed into the host's virtualRouteConfig: the route
// modules live in THIS package (src/routes/**), discovered by a
// physical() directory scan relative to the host's routes directory.
export const doctorsRoutesPlugin = definePlugin({
	id: "doctors.routes",
	meta: { keywords: ["doctors", "routes"] },
	routes: [physical("/doctors", "../../../../plugins/doctors/src/routes")],
	// Route-registry def (PL-011) for the file-route subtree above —
	// the portal chooser pages self-register from their descriptors.
	contributions: [routeContribution("doctors.select", { path: "/doctors/select" })],
});

/** The clinical portals the profile chooser is mounted in — doctor
 * AND secretary: picking the acting profile matters in both. */
const CLINICAL_PORTALS = ["doctor", "secretary"] as const;

/**
 * Chooser page loader: the account's profiles plus the one this
 * request acts as. `subject: "doctor"` binds the ACTING doctor, so
 * `principal.userId` identifies the active profile's entry while
 * `actorId` names the signed-in account the directory is read for.
 * Claims pending invites first — the chooser is an entry point.
 */
const selectDoctorLoader = (_path: string) =>
	Effect.gen(function* () {
		const principal = yield* Principal;
		if (principal === null) return { profiles: [], activeDoctorId: null };
		const directory = yield* Effect.serviceOption(DoctorProfiles);
		if (Option.isNone(directory)) return { profiles: [], activeDoctorId: null };
		const accountId = principal.actorId ?? principal.userId;
		yield* directory.value.claimInvites(accountId);
		const profiles = yield* directory.value.listFor(accountId);
		return {
			profiles: profiles.map(({ doctorId, displayName, role }) => ({
				doctorId,
				displayName,
				role,
			})),
			activeDoctorId: profiles.find((p) => p.userId === principal.userId)?.doctorId ?? null,
		};
	});

// Portal page (P-081): the chooser itself lives inside each clinical
// portal — the app route /doctors/select stays for the sign-in flow.
export const doctorsPagesPlugin = definePlugin({
	id: "doctors.pages",
	meta: { keywords: ["doctors", "ui", "doctor"] },
	requiredDeps: [portalShellPlugin.id],
	pages: CLINICAL_PORTALS.map((portal): Page => ({
		id: `doctors.${portal}.select`,
		path: `/portal/${portal}/switch-doctor`,
		component: DoctorSelectPortalPage,
		loader: selectDoctorLoader,
	})),
});

const switchDoctorChrome = (portal: (typeof CLINICAL_PORTALS)[number]): ChromeContribution => ({
	id: `doctors.nav.switch.${portal}`,
	region: "portal.sidebar",
	portal,
	// Only meaningful when the account acts through more than one
	// profile — an owner without delegations has nothing to switch to.
	when: { minUserCounts: { doctorProfiles: 2 } },
	content: {
		kind: "sidebarItem",
		item: {
			to: `/portal/${portal}/switch-doctor`,
			label: "Switch doctor",
			icon: ArrowLeftRightIcon,
			group: "Account",
		},
	},
});

// Chrome contribution (P-060): the sidebar entries point at the
// in-portal chooser above. The dep edge orders them after the portal
// shell anchor.
export const doctorsChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/portal/doctor/switch-doctor": "nav_switch_doctor",
			"/portal/secretary/switch-doctor": "nav_switch_doctor",
		},
		groups: { Account: "panel_group_account" },
	},
	id: "doctors.chrome",
	meta: { keywords: ["doctors", "ui", "doctor"] },
	requiredDeps: [portalShellPlugin.id],
	chrome: CLINICAL_PORTALS.map(switchDoctorChrome),
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	doctorsTablesPlugin,
	doctorsServicesPlugin,
	doctorsRoutesPlugin,
	doctorsPagesPlugin,
	doctorsChromePlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"doctors.tables": true;
		"doctors.services": true;
		"doctors.routes": true;
		"doctors.pages": true;
		"doctors.chrome": true;
	}
}

// Route-registry key (PL-011): the path literal must match the
// `routeContribution` meta above — `Routes.route()` types params off it.
declare module "@ktb/platform/routes" {
	interface RouteRegistry {
		"doctors.select": "/doctors/select";
	}
}
