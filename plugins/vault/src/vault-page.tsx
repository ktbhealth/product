import { useMemo } from "react";

import { makeKeyring } from "@ktb/crypto/keyring";
import type { PageContext } from "@ktb/kernel";

import { vaultApi } from "./apis.ts";
import { VaultSettingsPage, type VaultPageData } from "./views/index.ts";

/**
 * `pages` component for /portal/<instance>/vault (T-143): the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it into the view's props and binds the real keyring
 * (IndexedDB device store) plus the plugin's server fns.
 */
export function VaultClinicPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const page = (data ?? {}) as Partial<VaultPageData>;
	// One keyring per mount — the service memoizes the device identity
	// internally, so re-creating it per render would redo IndexedDB I/O.
	const keyring = useMemo(() => makeKeyring(), []);
	return (
		<VaultSettingsPage
			data={{
				tenantId: page.tenantId ?? null,
				role: page.role ?? null,
				zk: page.zk ?? false,
				devices: page.devices ?? [],
				secrets: page.secrets ?? [],
			}}
			api={vaultApi}
			keyring={keyring}
			locale={ctx.locale}
		/>
	);
}
