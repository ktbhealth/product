import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import { createCatalogT, sliceMessages } from "@ktb/i18n";
import type { ChromeContribution, PageContext } from "@ktb/kernel";

import { I18N_NAMESPACE, signInMessages } from "../i18n.ts";
import { visibleLoginTiles, type LoginTileStates } from "../login-tiles.ts";

export interface LoginPickerPageProps {
	/** Page loader payload — the picker declares no loader, so this is
	 * always null in production; tests may inject values. */
	readonly data: unknown;
	readonly ctx: PageContext;
}

/**
 * /login — front door role picker (moved from the host file route
 * apps/web/src/routes/login.tsx). The header's single "Sign in" entry
 * lands here and the visitor picks which sign-in form to use. The
 * tiles are plugin-contributed (P-099): each sign-in flow's owning
 * plugin declares a `loginTile` into `app.login.tiles` and
 * `visibleLoginTiles` (local reimplementation — see login-tiles.ts)
 * renders whatever is live per P-058 plugin_state. /portal/login and
 * /secretaries/login stay as legacy redirects for access emails and
 * bookmarks already sent.
 *
 * Tile labels are `app.<labelKey>` lookups resolved from the route's
 * DB catalog slice — tiles declare their own English `fallback`, which
 * wins when even the baseline lacks the key (same contract the host
 * route applied).
 */
export function LoginPickerPage({ ctx }: LoginPickerPageProps) {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, signInMessages(ctx.locale));
	// `app.<key>` lookup over the same catalog slice; the tile's own
	// fallback wins when the key is absent.
	const appT = createCatalogT(ctx.i18n?.catalog ?? {}, ctx.i18n?.locale ?? ctx.locale);
	const appLabel = (key: string, fallback: string) => {
		const full = `app.${key}`;
		const resolved = appT(full);
		return resolved === full ? fallback : resolved;
	};
	// ctx.pluginStates is the raw enablement snapshot the chrome gates
	// check `requires` against; when a host omits it, ctx.plugins is
	// already enabled-filtered, so every registry id counts as live.
	const states: LoginTileStates = ctx.pluginStates ?? {
		enabled: ctx.plugins.map((p) => p.id),
	};
	const tiles = visibleLoginTiles(ctx.plugins, states);
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>{t.pickerHeading}</CardTitle>
					<CardDescription>{t.pickerDesc}</CardDescription>
				</CardHeader>
				<CardContent className="grid grid-flow-col auto-cols-fr gap-2">
					{tiles.map((entry) => {
						// visibleLoginTiles already filters to loginTile entries.
						const {
							to,
							labelKey,
							fallback,
							icon: Icon,
						} = entry.content as Extract<ChromeContribution["content"], { kind: "loginTile" }>;
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
								{appLabel(labelKey, fallback)}
							</Link>
						);
					})}
				</CardContent>
			</Card>
		</div>
	);
}
