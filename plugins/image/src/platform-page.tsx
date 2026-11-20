import type { PanelPageContext } from "@ktb/kernel";

import type { ImageAdminPageProps, ImageRow } from "./views/ImageAdminPage.tsx";
import { ImageAdminPage } from "./views/ImageAdminPage.tsx";

const asRows = (data: unknown): readonly ImageRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is ImageRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as ImageRow).id === "number" &&
					typeof (row as ImageRow).src === "string",
			)
		: [];

/**
 * `panel.pages` component for /platform/images: the host dispatcher
 * hands the loader Effect's result (every `images` row as wire meta)
 * as `data`; this wrapper narrows it into the view's props. The admin
 * gate already ran in the page `guard` and inside every `Images.admin*`
 * method.
 */
export function ImageAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: ImageAdminPageProps = {
		images: asRows(data),
		plugins: ctx.plugins,
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <ImageAdminPage {...props} />;
}
