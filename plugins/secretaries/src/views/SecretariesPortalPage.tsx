import { useRouter } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";

import { inviteSecretaryFn, revokeSecretaryFn } from "../fns.ts";
import { SecretariesPage, type SecretaryListItem } from "./SecretariesPage.tsx";

/**
 * Secretaries management mounted inside the doctor portal (P-081) —
 * the signed-in account's own list (never a delegated doctor's),
 * wired to this plugin's fns. `invalidate` re-runs the portal page
 * loader after an invite or a revoke.
 */
export function SecretariesPortalPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PageContext;
}) {
	const router = useRouter();
	return (
		<SecretariesPage
			secretaries={(data as readonly SecretaryListItem[] | null) ?? []}
			i18n={ctx.i18n}
			locale={ctx.locale}
			api={{
				invite: (email) => inviteSecretaryFn({ data: { email } }),
				revoke: (id) => revokeSecretaryFn({ data: id }),
			}}
			onChanged={() => void router.invalidate()}
		/>
	);
}
