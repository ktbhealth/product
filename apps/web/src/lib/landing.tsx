import { createElement } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import { plugins } from "#/plugins.ts";
import { enabledIdSet, enabledPlugins } from "#/lib/registry.ts";

const rootApi = getRouteApi("__root__");

// Landing dispatch (was routes/index.tsx): a plugin may own the whole
// landing page (`landing.page`); the first ENABLED contribution in
// topo order wins (P-058). The audience plugin (P-056) owns it — the
// fallback only renders if no landing plugin is registered.
function MissingLanding() {
	// Brand comes from the resolved theme (PL-006 phase 7) — the
	// built-in KTB default keeps `appName` populated with zero rows.
	const { theme } = rootApi.useLoaderData();
	return (
		<section className="mx-auto flex max-w-2xl flex-col items-center px-6 pt-24 text-center">
			{theme?.appName ? (
				<h1 className="text-3xl font-bold tracking-tight">{theme.appName}</h1>
			) : null}
			<Link to="/consultations" className={buttonVariants() + " mt-8"}>
				Consultations
			</Link>
		</section>
	);
}

export function Landing() {
	const { pluginStates, i18n } = rootApi.useLoaderData();
	const Page = enabledPlugins(plugins, enabledIdSet(pluginStates)).find(
		(p) => p.landing !== undefined,
	)?.landing?.page;
	// `locale`/`i18n` are injected by the host — plugins cannot import
	// the host's i18n runtime (see LandingPageProps in @ktb/kernel).
	return Page === undefined ? (
		<MissingLanding />
	) : (
		createElement(Page, { locale: i18n?.locale ?? "en", i18n })
	);
}
