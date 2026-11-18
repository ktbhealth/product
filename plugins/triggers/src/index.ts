import { definePlugin, type Plugin } from "@ktb/kernel";
import { documentStoreServicesPlugin } from "@ktb/document-store";

import { TriggersServicesLive } from "./service.ts";

export * from "./definition.ts";
export * from "./hooks.ts";
export * from "./runner.ts";
export * from "./service.ts";

/**
 * Triggers plugin: declarative `trigger.def` reactions — WHEN a
 * document-store write matches (collection + ops + optional condition)
 * DO a collection-write or a TriggersHooks handler. The runtime
 * subscribes to `document-store.record-written` on the app-wide
 * EventBus; defs are collected once at composition into the
 * `TriggerDefinitions` registry @ktb/app-host provides (same pattern
 * as DocumentCollections/ViewDefinitions/ApiExposures).
 *
 * Plugin ids follow the `<pkg>.<concern>` convention; each object
 * carries exactly one contribution kind (kernel contract).
 */

/**
 * Triggers + TriggersHooks services. `TriggersServicesLive` merges the
 * event consumer with the hook registry OTHER plugins register
 * reaction handlers on — depend on `triggers.services` to order after
 * it. The dep edge on `document-store.services` keeps the store layer
 * (and its write-event publisher) ordered first; `EventBus` and
 * `TriggerDefinitions` come from app-host core like every plugin.
 */
export const triggersServicesPlugin = definePlugin({
	id: "triggers.services",
	meta: { keywords: ["triggers", "services"] },
	requiredDeps: [documentStoreServicesPlugin.id],
	services: TriggersServicesLive,
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [triggersServicesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"triggers.services": true;
	}
}
