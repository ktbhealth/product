import type { PanelPageContext } from "@ktb/kernel";
import type { EventTopicInfo, PubSubTopicsResult } from "@ktb/server-fns";

import { PubSubPage } from "./views/PubSubPage.tsx";

/** Loader payload for /platform/pubsub — null when the topic sources
 * cannot be read at all (the view renders the unavailable state);
 * `degraded` lists bound sources whose probe failed. */
export interface PubSubPageData {
	readonly topics: PubSubTopicsResult | null;
	readonly declaredTopics?: readonly EventTopicInfo[] | null;
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
	return (
		<PubSubPage
			listing={d.topics ?? null}
			declared={d.declaredTopics ?? null}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
