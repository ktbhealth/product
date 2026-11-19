import { useEffect } from "react";

import { useNavigate } from "@tanstack/react-router";

import type { PanelPageContext } from "@ktb/kernel";

import type { DraftsPageData } from "./views/DraftsPage.tsx";
import { DraftsPage } from "./views/DraftsPage.tsx";
import type { I18nPageData } from "./views/I18nPage.tsx";
import { I18nPage } from "./views/I18nPage.tsx";
import type { LocalesPageData } from "./views/LocalesPage.tsx";
import { LocalesPage } from "./views/LocalesPage.tsx";
import type { NamespacesPageData } from "./views/NamespacesPage.tsx";
import { NamespacesPage } from "./views/NamespacesPage.tsx";

const EMPTY: I18nPageData = { namespaces: [], locales: [] };
const EMPTY_LOCALES: LocalesPageData = { locales: [] };
const EMPTY_DRAFTS: DraftsPageData = { drafts: [], locales: [] };
const EMPTY_NAMESPACES: NamespacesPageData = { namespaces: [], coverage: [], locales: [] };

/**
 * `panel.pages` components for the /platform/i18n subtree: the host
 * dispatcher hands the loader Effect's result as `data`; these wrappers
 * narrow it into each view's props. Guard/loader run server-side in
 * ./index.ts under the session principal.
 */
export function I18nPlatformPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<I18nPageData>;
	return (
		<I18nPage
			data={{
				namespaces: Array.isArray(d.namespaces) ? d.namespaces : EMPTY.namespaces,
				locales: Array.isArray(d.locales) ? d.locales : EMPTY.locales,
			}}
		/>
	);
}

export function I18nLocalesPlatformPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<LocalesPageData>;
	return (
		<LocalesPage data={{ locales: Array.isArray(d.locales) ? d.locales : EMPTY_LOCALES.locales }} />
	);
}

export function I18nDraftsPlatformPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<DraftsPageData>;
	return (
		<DraftsPage
			data={{
				drafts: Array.isArray(d.drafts) ? d.drafts : EMPTY_DRAFTS.drafts,
				locales: Array.isArray(d.locales) ? d.locales : EMPTY_DRAFTS.locales,
			}}
		/>
	);
}

export function I18nNamespacesPlatformPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<NamespacesPageData>;
	return (
		<NamespacesPage
			data={{
				namespaces: Array.isArray(d.namespaces) ? d.namespaces : EMPTY_NAMESPACES.namespaces,
				coverage: Array.isArray(d.coverage) ? d.coverage : EMPTY_NAMESPACES.coverage,
				locales: Array.isArray(d.locales) ? d.locales : EMPTY_NAMESPACES.locales,
			}}
		/>
	);
}

/** /platform/i18n predates the messages/locales split — keep the old
 * URL working by forwarding to the messages matrix. */
export function I18nIndexRedirect(_props: { data: unknown; ctx: PanelPageContext }) {
	const navigate = useNavigate();
	useEffect(() => {
		void navigate({ to: "/platform/i18n/messages", replace: true });
	}, [navigate]);
	return null;
}
