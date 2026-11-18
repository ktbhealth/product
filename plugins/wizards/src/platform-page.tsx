import type { PanelPageContext } from "@ktb/kernel";

import { collectWizardDefinitions } from "./definition.ts";
import type { WizardDefWire } from "./fns.ts";
import { WizardsAdminPage, type WizardsAdminPageProps } from "./views/WizardsAdminPage.tsx";

const asDefs = (data: unknown): readonly WizardDefWire[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is WizardDefWire =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as WizardDefWire).key === "string" &&
					typeof (row as WizardDefWire).definition === "object",
			)
		: [];

/**
 * `panel.pages` component for /platform/wizards: the host dispatcher
 * hands the loader Effect's result (every `wizard_defs` row, drafts
 * included) as `data`; this wrapper narrows it into the view's props
 * and collects code-contributed defs from `ctx.plugins` for the
 * read-only listing. The admin gate already ran in the page `guard`
 * and inside every `Wizards.admin*` method.
 */
export function WizardsAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: WizardsAdminPageProps = {
		defs: asDefs(data),
		codeDefs: collectWizardDefinitions(ctx.plugins),
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <WizardsAdminPage {...props} />;
}
