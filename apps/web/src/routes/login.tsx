import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";

import { appCatalogT, appMessage, i18nSliceFromHeadMatches, useRootI18nSlice } from "#/lib/i18n.ts";

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

// The patient form stays the primary CTA (default variant), like the
// old header; the staff roles take the outline treatment.
const ROLES: readonly {
	to: "/login/patient" | "/login/doctor" | "/login/secretary";
	key: string;
	variant?: "outline";
}[] = [
	{ to: "/login/patient", key: "nav_patient_login" },
	{ to: "/login/doctor", key: "nav_doctor_login", variant: "outline" },
	{ to: "/login/secretary", key: "nav_secretary_login", variant: "outline" },
];

function LoginPickerPage() {
	const slice = useRootI18nSlice();
	const appT = appCatalogT(slice);
	const t = (key: string) => {
		const full = `app.${key}`;
		const resolved = appT(full);
		return resolved === full ? key : resolved;
	};
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t("login_picker_heading")}</CardTitle>
					<CardDescription>{t("login_picker_desc")}</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-2">
					{ROLES.map(({ to, key, variant }) => (
						<Link key={to} to={to} className={buttonVariants({ variant, className: "w-full" })}>
							{t(key)}
						</Link>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
