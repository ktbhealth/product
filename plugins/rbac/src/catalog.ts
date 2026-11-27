/**
 * Product permission catalog (P-054): the flat `(resource, action)`
 * keys role grants are validated against — the concrete vocabulary the
 * domain services check by hand until the generator lands. This lives
 * in the product layer (plugins/rbac owns the RBAC surface: the
 * superadmin seed grants every entry and the admin matrix enumerates
 * them); the `@ktb/rbac` engine stays domain-blind and accepts any
 * `PermissionCatalog`.
 *
 * Entries are `"resource.action"` strings — the same spelling
 * `Permissions.can(resource, action)` and `requireObject`/`canObject`
 * checks use.
 */

/** Actions the platform layer owns, outside any entity vocabulary. */
const PLATFORM_ACTIONS = [
	"platform.admin",
	"billing.manage",
	"members.invite",
	"groups.read",
	"groups.manage",
	"rbac.read",
	"rbac.manage",
	"audit.read",
	"eval.validator",
	"i18n.messages.read",
	"i18n.messages.edit",
	"i18n.locales.manage",
] as const;

/** Entity actions the domain services check (patients, consultations). */
const ENTITY_ACTIONS = [
	"patient.create",
	"patient.read",
	"patient.update",
	"patient.delete",
	"consultation.create",
	"consultation.read",
	"consultation.update",
	"consultation.delete",
] as const;

/** The full known catalog: entity actions + platform actions. */
export const PERMISSION_CATALOG = [...ENTITY_ACTIONS, ...PLATFORM_ACTIONS] as const;
