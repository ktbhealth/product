import { authClient } from "@ktb/auth-better/client";
import { initClientTelemetry, instrumentRouter } from "@ktb/observability/client";
import { TooltipProvider } from "@ktbhealth/ui/components/tooltip";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	type ErrorComponentProps,
	HeadContent,
	Link,
	Scripts,
	useLocation,
	useRouter,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { SearchXIcon, TriangleAlertIcon } from "lucide-react";
import { createElement, useEffect, type ReactNode } from "react";
import {
	appMessage,
	changeLocale,
	localeName,
	pluginFooterNote,
	pluginNavLabel,
	useRootI18nSlice,
} from "#/lib/i18n.ts";
import {
	collectChrome,
	enabledIdSet,
	enabledPlugins,
	KNOWN_CHROME_REGIONS,
	portalInstances,
	warnUnknownChromeRegions,
} from "#/lib/registry.ts";
import { sessionFn, pluginStatesFn, i18nRouteFn } from "#/lib/fns.ts";
import { themeScopeFn } from "@ktb/theme/fns";
import { themeHead, themeTitle } from "@ktb/theme/head";
import { ThemePreviewBanner } from "@ktb/theme/views";
import type { ResolvedTheme } from "@ktb/theme/types";
import { plugins } from "#/plugins.ts";
import type { ChromeContribution, ChromeProps, PageI18nSlice } from "@ktb/kernel";
import appCss from "../styles.css?url";

// Chrome regions (P-060): this shell declares the app.* slots; plugins
// fill them via `chrome` contributions. The dev warning uses the union
// of all shell regions so console.* contributions aren't false positives.
if (import.meta.env.DEV) warnUnknownChromeRegions(plugins, KNOWN_CHROME_REGIONS);

/** Console surfaces own the whole viewport and resolve their OWN theme
 * (portal-instance → tenant → platform) in their route loaders — the
 * app shell must not double-inject branding there (P-082). */
const isConsolePathname = (pathname: string): boolean => {
	if (pathname === "/platform" || pathname.startsWith("/platform/")) return true;
	if (!pathname.startsWith("/portal/")) return false;
	const segment = pathname.slice("/portal/".length).split("/")[0];
	return (
		segment !== undefined &&
		segment !== "" &&
		portalInstances.some((e) => e.instance.id === segment)
	);
};

export const Route = createRootRoute({
	// Session user + enabled plugin ids (P-058) — chrome/landing/panel
	// contributions are filtered by the enabled set before render. The
	// theme resolves session → tenant → platform (P-082); console paths
	// ignore it (their shells resolve per-instance themes).
	loader: async (ctx) => {
		// `ctx` is typed non-optional but bare unit tests invoke the
		// loader without arguments — tolerate that.
		const pathname = ctx?.location?.pathname ?? "/";
		// searchStr carries `?locale=` through client-side navigations —
		// the server-fn RPC request URL would not (PL-008).
		const search = ctx?.location?.searchStr ?? "";
		return {
			user: await sessionFn(),
			pluginStates: await pluginStatesFn(),
			theme: await themeScopeFn({ data: { scope: "session" } }),
			// DB-backed i18n slice for this path (PL-008): namespaces derived
			// from the registry + resolved catalog for the request locale.
			i18n: await i18nRouteFn({ data: { pathname, search } }),
		};
	},
	head: (ctx) => {
		const loaderData = ctx?.loaderData;
		const pathname = ctx?.match?.pathname ?? "";
		const theme =
			loaderData?.theme !== null && loaderData?.theme !== undefined && !isConsolePathname(pathname)
				? (loaderData.theme as ResolvedTheme)
				: null;
		const themed = theme === null ? null : themeHead(theme);
		const title = theme === null ? null : themeTitle(theme);
		const i18n = loaderData?.i18n as PageI18nSlice | undefined;
		const metaTitle = appMessage(i18n, "meta_title", "KTB Health");
		const metaDescription = appMessage(i18n, "meta_description", "");
		return {
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ title: title ?? metaTitle },
				{ name: "description", content: metaDescription },
				{ name: "robots", content: "index, follow" },
				{ property: "og:type", content: "website" },
				{ property: "og:title", content: title ?? metaTitle },
				{ property: "og:description", content: metaDescription },
				{ name: "twitter:card", content: "summary" },
				{ name: "twitter:title", content: title ?? metaTitle },
				{ name: "twitter:description", content: metaDescription },
				// Theme og:image only (P-082) — the rest of the theme head
				// (favicon/font links) rides `links` below.
				...(themed?.meta ?? []),
			],
			links: [
				{ rel: "stylesheet", href: appCss },
				// Favicon + font-delivery links from the resolved theme.
				...(themed?.links ?? []),
			],
		};
	},
	shellComponent: RootDocument,
	errorComponent: RootError,
	notFoundComponent: NotFound,
});

/** `app.*` copy for shell-level surfaces (404/error) that render outside
 * a page context — they still read the root loader's i18n slice. */
function useAppCopy() {
	const slice = useRootI18nSlice();
	return (key: string, fallback = "") => appMessage(slice, key, fallback);
}

function NotFound() {
	const t = useAppCopy();
	return (
		<div className="py-24 text-center">
			<SearchXIcon className="mx-auto size-12 text-muted-foreground" />
			<h1 className="mt-4 text-2xl font-bold tracking-tight">{t("notfound_title")}</h1>
			<p className="mt-1 text-sm text-muted-foreground">{t("notfound_body")}</p>
			<Link
				to="/consultations"
				className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
			>
				{t("notfound_cta")}
			</Link>
		</div>
	);
}

/**
 * Root error boundary — friendly localized message, never a stack trace.
 * `reset` re-runs the failed loader; the link offers a way out when the
 * failure is permanent.
 */
function RootError({ reset }: ErrorComponentProps) {
	const t = useAppCopy();
	return (
		<div className="py-24 text-center">
			<TriangleAlertIcon className="mx-auto size-12 text-muted-foreground" />
			<h1 className="mt-4 text-2xl font-bold tracking-tight">{t("error_title")}</h1>
			<p className="mt-1 text-sm text-muted-foreground">{t("error_body")}</p>
			<div className="mt-6 flex items-center justify-center gap-3">
				<button
					type="button"
					onClick={reset}
					className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
				>
					{t("error_retry")}
				</button>
				<Link
					to="/consultations"
					className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted"
				>
					{t("notfound_cta")}
				</Link>
			</div>
		</div>
	);
}

const NAV_LINK =
	"rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground";
const NAV_ACTIVE = "bg-muted text-foreground";

/**
 * Browser telemetry bootstrap (P-099): instruments fetch (injects
 * traceparent/request-id, records request timings), window errors and
 * router navigations, and batches events to /api/telemetry. Runs once
 * per document; `initClientTelemetry` is idempotent across HMR.
 */
function TelemetryInit() {
	const router = useRouter();
	useEffect(() => {
		initClientTelemetry({ endpoint: "/api/telemetry" });
		// RouterCore's subscribe is generic/overloaded — the structural
		// InstrumentableRouter view only needs the two events we read.
		instrumentRouter(router as unknown as Parameters<typeof instrumentRouter>[0]);
	}, [router]);
	return null;
}

function RootDocument({ children }: { children: React.ReactNode }) {
	const { user, pluginStates, theme, i18n } = Route.useLoaderData();
	// A patient account (no doctor profile to act as) only ever sees the
	// patient portal: no doctor navigation, nothing that creates or
	// switches doctor profiles.
	const patientOnly = user?.patientOnly === true;
	const pathname = useLocation({ select: (l) => l.pathname });
	// Portal surfaces are system chrome, not app pages — /platform* and
	// /portal/<instanceId>/* (P-081) own the whole viewport (their route
	// renders PortalShell) so the marketing header/footer and the
	// max-w-6xl column don't wrap them. /portal itself and the patient
	// portal's physical routes keep the marketing chrome: their first
	// segment is not a contributed instance id.
	const isConsole = isConsolePathname(pathname);
	// Theme style block (P-082): exactly one `<style>` per app-shell page,
	// emitted only off-console — portal shells resolve and inject their
	// own instance theme. `.dark` inside the block stays user-preference
	// driven; the override only redefines custom properties.
	const themeCss =
		!isConsole && theme !== null && theme !== undefined
			? `${theme.styleCss}\n${theme.fontFaceCss}`.trim()
			: "";
	// Enabled-state filter (P-058): disabled plugins contribute nothing
	// to any chrome region.
	const visiblePlugins = enabledPlugins(plugins, enabledIdSet(pluginStates));
	// Chrome regions (P-060): the shell owns the slots; plugins fill
	// them via `chrome` contributions filtered by `when` + pathname.
	const slice = i18n as PageI18nSlice | undefined;
	const activeLocale = i18n?.locale ?? "en";
	const chromeProps: ChromeProps = {
		user,
		locale: activeLocale,
		i18n: slice,
		plugins: visiblePlugins,
		locales: i18n?.enabledLocales ?? ["en"],
		localeName: (l: string) => localeName(l, slice),
		setLocale: changeLocale,
		labels: {
			signIn: appMessage(slice, "nav_sign_in", "Sign in"),
			signOut: appMessage(slice, "nav_sign_out", "Sign out"),
			newConsultation: appMessage(slice, "nav_new_consultation", "+ New consultation"),
			langMenu: appMessage(slice, "lang_menu_label", "Language"),
			switchDoctor: appMessage(slice, "nav_switch_doctor", "Switch doctor"),
			secretaries: appMessage(slice, "nav_secretaries", "Secretaries"),
			patientPortal: appMessage(slice, "nav_patient_portal", "Patient portal"),
			platformConsole: appMessage(slice, "nav_platform_console", "Platform"),
			myConsultations: appMessage(slice, "nav_my_consultations", "My consultations"),
		},
		signOut: async () => {
			await authClient.signOut();
			window.location.assign("/");
		},
		// Resolved theme for brand chrome (PL-006 phase 7) — the
		// theme.brand contribution renders it; null only when the
		// loader's theme resolution came back empty (console routes
		// resolve their own instance theme instead).
		theme,
	};
	const entries = (region: string) => collectChrome(visiblePlugins, region, pathname);
	const renderEntry = (entry: ChromeContribution): ReactNode => {
		const { content } = entry;
		switch (content.kind) {
			case "link":
				return (
					<Link
						key={entry.id}
						to={content.to}
						className={NAV_LINK}
						activeProps={{ className: `${NAV_LINK} ${NAV_ACTIVE}` }}
					>
						{pluginNavLabel(content.to, content.label, slice)}
					</Link>
				);
			case "component":
				return createElement(content.component, { key: entry.id, ...chromeProps });
			default:
				// sidebarItem/headerAction/footerBlock/note belong to other
				// shells or footer regions — never rendered in the header.
				return null;
		}
	};
	const brand = entries("app.header.brand").map(renderEntry);
	const nav = patientOnly
		? [
				<Link
					key="portal"
					to="/portal"
					className={NAV_LINK}
					activeProps={{ className: `${NAV_LINK} ${NAV_ACTIVE}` }}
				>
					{appMessage(slice, "nav_my_consultations", "My consultations")}
				</Link>,
			]
		: entries("app.header.nav").map(renderEntry);
	const actions = entries("app.header.actions").map(renderEntry);
	const session = entries("app.header.session").map(renderEntry);
	const footerBlocks = entries("app.footer.blocks").flatMap((entry) =>
		entry.content.kind === "footerBlock" ? [entry.content.block] : [],
	);
	const footerNotes = entries("app.footer.note").flatMap((entry) =>
		entry.content.kind === "note"
			? [
					<div key={entry.id}>
						{pluginFooterNote(entry.content.key, entry.content.fallback, slice)}
					</div>,
				]
			: [],
	);
	return (
		<html lang={activeLocale}>
			<head>
				<HeadContent />
			</head>
			<body className="flex min-h-screen flex-col bg-background text-foreground antialiased">
				<TooltipProvider>
					<TelemetryInit />
					{themeCss !== "" ? <style dangerouslySetInnerHTML={{ __html: themeCss }} /> : null}
					{isConsole ? (
						children
					) : (
						<>
							{theme?.preview === true ? (
								<ThemePreviewBanner locale={activeLocale} i18n={slice} />
							) : null}
							<header className="sticky top-0 z-40 border-b border-border bg-background">
								<nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
									{brand}
									<div className="flex items-center gap-1.5">
										{nav}
										{actions}
										{session}
									</div>
								</nav>
							</header>
							<main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
							<footer className="mx-auto max-w-6xl px-6 pb-8 text-xs text-muted-foreground">
								{footerBlocks.length > 0 ? (
									<div className="mb-4 flex flex-wrap gap-x-10 gap-y-4">
										{footerBlocks.map((block, i) => (
											<div key={block.heading ?? i}>
												{block.heading ? (
													<div className="font-semibold text-foreground">{block.heading}</div>
												) : null}
												<ul className="mt-1 space-y-1">
													{block.links.map((link) => (
														<li key={link.to}>
															<Link to={link.to} className="transition hover:text-foreground">
																{link.label}
															</Link>
														</li>
													))}
												</ul>
											</div>
										))}
									</div>
								) : null}
								{footerNotes}
							</footer>
							<TanStackDevtools
								config={{ position: "bottom-right" }}
								plugins={[
									{
										name: "Tanstack Router",
										render: <TanStackRouterDevtoolsPanel />,
									},
								]}
							/>
						</>
					)}
				</TooltipProvider>
				<Scripts />
			</body>
		</html>
	);
}
