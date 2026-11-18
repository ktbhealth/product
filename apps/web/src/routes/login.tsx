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
 * (/login/secretary). /portal/login stays as a legacy redirect to the
 * patient form for access emails and bookmarks already sent.
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

function LoginPickerPage() {
	const slice = useRootI18nSlice();
	const appT = appCatalogT(slice);
	const t = (key: string) => appT(`app.${key}`);
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t("login_picker_heading")}</CardTitle>
					<CardDescription>{t("login_picker_desc")}</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-2">
					{/* The patient form is the primary CTA, like the old header. */}
					<Link to="/login/patient" className={buttonVariants({ className: "w-full" })}>
						{t("nav_patient_login")}
					</Link>
					<Link
						to="/login/doctor"
						className={buttonVariants({ variant: "outline", className: "w-full" })}
					>
						{t("nav_doctor_login")}
					</Link>
					<Link
						to="/login/secretary"
						className={buttonVariants({ variant: "outline", className: "w-full" })}
					>
						{t("nav_secretary_login")}
					</Link>
				</CardContent>
			</Card>
		</div>
	);
}
