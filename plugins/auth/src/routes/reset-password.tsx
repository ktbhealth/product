import { createPluginFileRoute } from "@ktb/server-fns";
import type { SearchSchemaInput } from "@tanstack/react-router";

import { localeFn } from "../fns.ts";
import { authMessages } from "../i18n.ts";
import { ResetPasswordPage } from "../views/ResetPasswordPage.tsx";

/**
 * /reset-password — the emailed link lands here after the auth API's
 * /reset-password/:token hop validates it: `?token=` on success,
 * `?error=` on failure. Only string params are forwarded — anything
 * else collapses to the invalid-link state. Gated on `auth.routes`.
 */
export const Route = createPluginFileRoute("auth.routes")("/reset-password")({
	validateSearch: (
		search: { token?: unknown; error?: unknown } & SearchSchemaInput,
	): { token: string | undefined; error: string | undefined } => ({
		token: typeof search.token === "string" ? search.token : undefined,
		error: typeof search.error === "string" ? search.error : undefined,
	}),
	loader: async () => ({ locale: await localeFn() }),
	head: ({ loaderData }) => ({
		meta: [{ title: authMessages(loaderData?.locale ?? "en").resetMetaTitle }],
	}),
	component: function ResetPasswordRoute() {
		const data = Route.useLoaderData();
		const { token, error } = Route.useSearch();
		return (
			<ResetPasswordPage
				locale={data?.locale ?? "en"}
				token={token}
				invalid={error !== undefined || token === undefined}
			/>
		);
	},
});
