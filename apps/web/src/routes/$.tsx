import { createElement } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { dispatchTarget } from "#/lib/dispatch-target.ts";
import { themeHeadResult } from "#/lib/theme-head.ts";
import { appBeforeLoad, appHead, appLoader, AppPage } from "#/lib/app-dispatch.tsx";
import { platformBeforeLoad, platformLoader, PlatformShell } from "#/lib/platform-dispatch.tsx";
import { portalBeforeLoad, portalLoader, PortalInstanceShell } from "#/lib/portal-dispatch.tsx";
import { Landing } from "#/lib/landing.tsx";

const pagePath = (splat: string | undefined): string => `/${splat ?? ""}`;

// Single plugin-page dispatcher (route collapse): every path the
// static file routes don't claim resolves here. dispatch-target.ts
// classifies the path — "/" → landing plugin picker, "/platform*" →
// console shell + panel page, "/portal/<instance>/*" → PortalShell +
// portal page, anything else → app-shell page descriptor. Unknown
// paths 404 exactly like the per-context file routes did.
export const Route = createFileRoute("/$")({
	beforeLoad: async (args) => {
		const target = dispatchTarget(pagePath(args.params._splat));
		if (target.kind === "platform") return platformBeforeLoad();
		if (target.kind === "portal") return portalBeforeLoad(target.instanceId ?? "");
		if (target.kind === "app") return appBeforeLoad(args);
	},
	// `loaderDeps` carries the parsed search into the loader: query
	// changes re-run it, so schema-bound pages re-validate their params
	// inside the page Effect (SSR and client navigations alike).
	loaderDeps: ({ search }) => ({ search }),
	loader: async ({ params, deps }) => {
		const target = dispatchTarget(pagePath(params._splat));
		const inner =
			target.kind === "platform"
				? await platformLoader({ params })
				: target.kind === "portal"
					? await portalLoader({ params, instanceId: target.instanceId ?? "" })
					: target.kind === "app"
						? await appLoader({ params, deps })
						: {};
		return { kind: target.kind, ...inner };
	},
	head: (ctx) => {
		const target = dispatchTarget(pagePath(ctx.params._splat));
		if (target.kind === "app") return appHead(ctx) as never;
		// platform/portal: theme head projection from the resolved
		// instance theme (P-082); landing has no head.
		const theme = (ctx.loaderData as { theme?: Parameters<typeof themeHeadResult>[0] } | undefined)
			?.theme;
		return themeHeadResult(theme) as never;
	},
	component: function RootDispatch() {
		const { _splat } = Route.useParams();
		const loaderData = Route.useLoaderData() as {
			kind: "landing" | "platform" | "portal" | "app";
		} & Record<string, unknown>;
		if (loaderData.kind === "platform") {
			return createElement(PlatformShell, {
				loaderData: loaderData as never,
			});
		}
		if (loaderData.kind === "portal") {
			return createElement(PortalInstanceShell, {
				loaderData: loaderData as never,
			});
		}
		if (loaderData.kind === "app") {
			return createElement(AppPage, {
				path: pagePath(_splat),
				loaderData: loaderData as never,
			});
		}
		return createElement(Landing);
	},
});
