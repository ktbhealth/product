-- T-188: re-pin tenant grants for strict tenantPolicy surfaces.
-- PR #225 made audit/document-store/views/wizards/api/flows resolve
-- grants under tenantPolicy "strict", which hides tenant_id NULL
-- tuples — every grant written so far is global, so those surfaces
-- deny inside tenant contexts. Role grants are catalog facts: the
-- tenant scope lives on the member tuple, so each global grant tuple
-- (object_id '*', subject_kind 'role', tenant_id NULL) is mirrored
-- onto every tenant the role has a tenant-pinned member tuple in.
-- Mirrors are derived state kept in sync by plugins/rbac
-- (assignSubject/setRolePermission/revokeRolePermission); the
-- NOT EXISTS natural-key guard keeps this idempotent. Direct
-- user/group-subject grants and entity-level tuples are NOT pinned —
-- they stay global-only under strict (fail closed) until pinned
-- deliberately.
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT g.`object_type`, g.`object_id`, g.`relation`, g.`subject_kind`, g.`subject_id`, g.`effect`, m.`tenant_id`, g.`expires_at`, g.`granted_by`, g.`created_at`
FROM `relation_tuples` g
JOIN (
	SELECT DISTINCT `object_id` AS `role_name`, `tenant_id`
	FROM `relation_tuples`
	WHERE `object_type` = 'role' AND `relation` = 'member' AND `tenant_id` IS NOT NULL
) m ON m.`role_name` = g.`subject_id`
WHERE g.`object_id` = '*' AND g.`subject_kind` = 'role' AND g.`tenant_id` IS NULL
AND NOT EXISTS (
	SELECT 1 FROM `relation_tuples` x
	WHERE x.`object_type` = g.`object_type` AND x.`object_id` = g.`object_id`
		AND x.`relation` = g.`relation` AND x.`subject_kind` = g.`subject_kind`
		AND x.`subject_id` = g.`subject_id` AND x.`tenant_id` = m.`tenant_id`
);
