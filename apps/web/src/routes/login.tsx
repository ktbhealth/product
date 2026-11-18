import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";

import { appCatalogT, appMessage, i18nSliceFromHeadMatches, useRootI18nSlice } from "#/lib/i18n.ts";
import { visibleLoginTiles } from "#/lib/login-tiles.ts";
import { plugins } from "#/plugins.ts";

const rootApi = getRouteApi("__root__");

/**
 * /login — front door role picker. The header's single "Sign in" entry
 * lands here and the visitor picks which sign-in form to use. The
 * tiles are plugin-contributed (P-099): each sign-in flow's owning
 * plugin declares a `loginTile` into `app.login.tiles` and
 * `visibleLoginTiles` renders whatever is live per P-058 plugin_state
 * (patient → /login/patient, doctor → /login/doctor, secretary →
 * /login/secretary). /portal/login and /secretaries/login stay as
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

function LoginPickerPage() {
	const slice = useRootI18nSlice();
	const appT = appCatalogT(slice);
	// `app.<key>` lookup; the caller's fallback wins when even the
	// baseline lacks the key (tiles declare their own English).
	const t = (key: string, fallback = key) => {
		const full = `app.${key}`;
		const resolved = appT(full);
		return resolved === full ? fallback : resolved;
	};
	const { pluginStates } = rootApi.useLoaderData();
	const tiles = visibleLoginTiles(plugins, pluginStates);
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>{t("login_picker_heading")}</CardTitle>
					<CardDescription>{t("login_picker_desc")}</CardDescription>
				</CardHeader>
				<CardContent className="grid grid-flow-col auto-cols-fr gap-2">
					{tiles.map((entry) => {
						if (entry.content.kind !== "loginTile") return null;
						const { to, labelKey, fallback, icon: Icon } = entry.content;
						return (
							<Link
								key={entry.id}
								to={to}
								className={buttonVariants({
									variant: "outline",
									className:
										"h-auto flex-col gap-2 px-2 py-4 text-center text-xs whitespace-normal",
								})}
							>
								<Icon className="size-6" />
								{t(labelKey, fallback)}
							</Link>
						);
					})}
				</CardContent>
			</Card>
		</div>
	);
}
