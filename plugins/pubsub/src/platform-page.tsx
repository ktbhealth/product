import type { PanelPageContext } from "@ktb/kernel";
import type { PubSubTopicInfo } from "@ktb/server-fns";

import { PubSubPage } from "./views/PubSubPage.tsx";

/** Loader payload for /platform/pubsub — null when the topic sources
 * cannot be read (the view renders the unavailable state). */
export interface PubSubPageData {
	readonly topics: readonly PubSubTopicInfo[] | null;
}

/**
 * `panel.pages` component for /platform/pubsub: the host dispatcher
 * hands the loader Effect's result as `data`; this wrapper narrows it
 * back into the view's props (the admin gate already ran in the page
 * `guard`, the layout's beforeLoad and inside every service call).
 * `ctx.locale` feeds the view's catalog.
 */
export function PubSubPlatformPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<PubSubPageData>;
	return <PubSubPage topics={d.topics ?? null} i18n={ctx.i18n} locale={ctx.locale} />;
}
