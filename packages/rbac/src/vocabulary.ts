/**
 * Permission vocabulary mechanics (P-054): the flat `"resource.action"`
 * string helpers the engine and product layers share. The engine is
 * domain-blind — it validates tuple SHAPE, never catalog membership —
 * so this module carries no concrete catalog. Each product/plugin
 * supplies its own `PermissionCatalog` (a readonly list of
 * `"resource.action"` keys) where it needs membership checks or
 * catalog enumeration (e.g. plugins/rbac's role seed and admin
 * matrix).
 *
 * Entries are `"resource.action"` strings — the same spelling
 * `Permissions.can(resource, action)` and `requireObject`/`canObject`
 * checks use.
 */

/** A permission catalog: the known `"resource.action"` keys a
 * deployment grants against. Plain strings — the engine never narrows
 * them, so any dotted spelling a product chooses is valid. */
export type PermissionCatalog = readonly string[];

/** Split a dotted `"resource.action"` catalog entry. */
export const splitPermission = (permission: string): { resource: string; action: string } => {
	const dot = permission.indexOf(".");
	return dot === -1
		? { resource: permission, action: "" }
		: { resource: permission.slice(0, dot), action: permission.slice(dot + 1) };
};

/** `"resource.action"` spelling of a (resource, action) pair. */
export const permissionKey = (resource: string, action: string): string => `${resource}.${action}`;

/** Build a membership check against a given catalog — exists for
 * role-editing UIs that want to warn on unknown grants, not as an
 * enforcement gate. */
export const isKnownPermission =
	(catalog: PermissionCatalog) =>
	(resource: string, action: string): boolean =>
		catalog.includes(permissionKey(resource, action));
