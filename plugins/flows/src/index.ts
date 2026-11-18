import { definePlugin, type Plugin } from "@ktb/kernel";
import { documentStoreServicesPlugin } from "@ktb/document-store";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";

import { FlowsServicesLive } from "./service.ts";

export * from "./definition.ts";
export * from "./hooks.ts";
export * from "./interpreter.ts";
export * from "./service.ts";

/**
 * Flows plugin: declarative `flow.def` state machines over
 * document-store collections — WHEN a caller invokes an event on a
 * governed record DO an atomic state+field write plus optional
 * post-commit FlowsHooks handlers. Defs are collected once at
 * composition into the `FlowDefinitions` registry @ktb/app-host
 * provides (same pattern as DocumentCollections/ViewDefinitions/
 * ApiExposures/TriggerDefinitions).
 *
 * Plugin ids follow the `<pkg>.<concern>` convention; each object
 * carries exactly one contribution kind (kernel contract).
 */

/**
 * Flows + FlowsHooks services. `FlowsServicesLive` merges the runtime
 * with the hook registry OTHER plugins register post-commit handlers
 * on — depend on `flows.services` to order after it. The dep edge on
 * `document-store.services` keeps the store layer ordered first;
 * `FlowDefinitions` and (optionally) `Permissions` come from app-host
 * core / the rbac plugin like every plugin. `rbac.services` is an
 * OPTIONAL dep purely for ordering: when the rbac plugin is enabled
 * its `Permissions` port is bound before this layer builds, so
 * `flow.def` `permission` gates resolve; when absent, permission'd
 * flows fail closed (see ./service.ts).
 */
export const flowsServicesPlugin = definePlugin({
	id: "flows.services",
	meta: { keywords: ["flows", "services"] },
	requiredDeps: [documentStoreServicesPlugin.id],
	optionalDeps: [rbacServicesPlugin.id],
	services: FlowsServicesLive,
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [flowsServicesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"flows.services": true;
	}
}
