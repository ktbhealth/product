import type { PanelPageContext } from "@ktb/kernel";

import type { CredentialCard } from "./index.ts";
import { CredentialsPage } from "./views/CredentialsPage.tsx";

export function CredentialsPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<CredentialsPage
			creds={Array.isArray(data) ? (data as CredentialCard[]) : []}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
