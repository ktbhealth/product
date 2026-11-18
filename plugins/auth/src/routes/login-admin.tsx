import { createPluginFileRoute } from "@ktb/server-fns";

import { localeFn } from "../fns.ts";
import { authMessages } from "../i18n.ts";
import { AdminLoginPage } from "../views/AdminLoginPage.tsx";

/**
 * /login/admin — dedicated superadmin sign-in (email allowlist or RBAC
 * `platform.admin` grant). Sign-in only — no sign-up — and the post-login
 * check runs `platformAdminAccessFn` before landing on /platform.
 * Gated on `auth.routes` enable state — a system plugin, so the gate
 * always passes.
 */
export const Route = createPluginFileRoute("auth.routes")("/login/admin")({
	loader: async () => ({ locale: await localeFn() }),
	head: ({ loaderData }) => ({
		meta: [{ title: authMessages(loaderData?.locale ?? "en").metaTitleAdmin }],
	}),
	component: function AdminLoginRoute() {
		const data = Route.useLoaderData();
		return <AdminLoginPage locale={data?.locale ?? "en"} />;
	},
});
