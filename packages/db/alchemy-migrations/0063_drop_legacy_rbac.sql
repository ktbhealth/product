-- T-183: relation_tuples is now the ONLY RBAC grant store — drop the
-- legacy admin tables. Defensive re-backfill first: rows written
-- between the 0061 deploy and this one are already mirrored by the
-- dual-write repo fns, but this guards any stragglers (NOT EXISTS on
-- the natural key keeps it idempotent).
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT `resource`, '*', `action`, 'role', `name`, `effect`, NULL, NULL, NULL, rp.`created_at`
FROM `role_permissions` rp JOIN `roles` r ON r.id = rp.role_id
WHERE NOT EXISTS (
	SELECT 1 FROM `relation_tuples` t
	WHERE t.`object_type` = rp.`resource` AND t.`object_id` = '*'
		AND t.`relation` = rp.`action` AND t.`subject_kind` = 'role'
		AND t.`subject_id` = r.`name` AND t.`tenant_id` IS NULL
);--> statement-breakpoint
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT 'role', `name`, 'member', `subject_kind`, `subject_id`, 'allow', `tenant_id`, `expires_at`, `granted_by`, sr.`created_at`
FROM `subject_roles` sr JOIN `roles` r ON r.id = sr.role_id
WHERE NOT EXISTS (
	SELECT 1 FROM `relation_tuples` t
	WHERE t.`object_type` = 'role' AND t.`object_id` = r.`name`
		AND t.`relation` = 'member' AND t.`subject_kind` = sr.`subject_kind`
		AND t.`subject_id` = sr.`subject_id`
		AND ((t.`tenant_id` IS NULL AND sr.`tenant_id` IS NULL) OR t.`tenant_id` = sr.`tenant_id`)
);--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
DROP TABLE `subject_roles`;
