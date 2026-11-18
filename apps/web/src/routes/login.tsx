import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import { ClipboardListIcon, HeartPulseIcon, StethoscopeIcon, type LucideIcon } from "lucide-react";

import { appCatalogT, appMessage, i18nSliceFromHeadMatches, useRootI18nSlice } from "#/lib/i18n.ts";
import { visibleLoginPortals, type LoginPortal } from "#/lib/login-roles.ts";

const rootApi = getRouteApi("__root__");

/**
 * /login — front door role picker. The header's single "Sign in" entry
 * lands here and the visitor picks which sign-in form to use: patient
 * (/login/patient), doctor (/login/doctor) or secretary
 * (/login/secretary). /portal/login and /secretaries/login stay as
 * legacy redirects for access emails and bookmarks already sent.
 */
export const Route = createFileRoute("/login")({
	head: (ctx) => {
		// Same pattern as /login/patient: the ROOT match's i18n slice
		// already honors `?locale=` — no extra server roundtrip.
		const i18n = i18nSliceFromHeadMatches(ctx?.matches);
		return {
			meta: [{ title: appMessage(i18n, "login_picker_meta_title", "Sign in | KTB Health") }],
		};
	},
	component: LoginPickerPage,
});

// Tiles render for the sign-in flows visibleLoginPortals reports live
// (P-058) — same rule the other login pages apply to their cross-links.
const ROLES: readonly {
	to: "/login/patient" | "/login/doctor" | "/login/secretary";
	key: string;
	icon: LucideIcon;
	portal: LoginPortal;
}[] = [
	{ to: "/login/patient", key: "nav_patient_login", icon: HeartPulseIcon, portal: "patient" },
	{ to: "/login/doctor", key: "nav_doctor_login", icon: StethoscopeIcon, portal: "doctor" },
	{
		to: "/login/secretary",
		key: "nav_secretary_login",
		icon: ClipboardListIcon,
		portal: "secretary",
	},
];

function LoginPickerPage() {
	const slice = useRootI18nSlice();
	const appT = appCatalogT(slice);
	const t = (key: string) => {
		const full = `app.${key}`;
		const resolved = appT(full);
		return resolved === full ? key : resolved;
	};
	const { pluginStates } = rootApi.useLoaderData();
	const visible = visibleLoginPortals(pluginStates);
	const roles = ROLES.filter(({ portal }) => visible.has(portal));
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>{t("login_picker_heading")}</CardTitle>
					<CardDescription>{t("login_picker_desc")}</CardDescription>
				</CardHeader>
				<CardContent className="grid grid-flow-col auto-cols-fr gap-2">
					{roles.map(({ to, key, icon: Icon }) => (
						<Link
							key={to}
							to={to}
							className={buttonVariants({
								variant: "outline",
								className: "h-auto flex-col gap-2 px-2 py-4 text-center text-xs whitespace-normal",
							})}
						>
							<Icon className="size-6" />
							{t(key)}
						</Link>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
