CREATE TABLE `relation_tuples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`relation` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`effect` text NOT NULL,
	`tenant_id` text,
	`expires_at` integer,
	`granted_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relation_tuples_object_idx` ON `relation_tuples` (`object_type`,`object_id`,`relation`);--> statement-breakpoint
CREATE INDEX `relation_tuples_subject_idx` ON `relation_tuples` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `relation_tuples_natural_idx` ON `relation_tuples` (`object_type`,`object_id`,`relation`,`subject_kind`,`subject_id`);--> statement-breakpoint
-- P-101 backfill: mirror existing RBAC rows into relation_tuples.
-- Timestamps are already epoch-ms integers (timestamp_ms storage),
-- so they copy verbatim. Role grants key on the role NAME; member
-- tuples carry the assignee subject and the assignment's
-- tenant/expiry/granter.
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT `resource`, '*', `action`, 'role', `name`, `effect`, NULL, NULL, NULL, rp.`created_at`
FROM `role_permissions` rp JOIN `roles` r ON r.id = rp.role_id;--> statement-breakpoint
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT 'role', `name`, 'member', `subject_kind`, `subject_id`, 'allow', `tenant_id`, `expires_at`, `granted_by`, sr.`created_at`
FROM `subject_roles` sr JOIN `roles` r ON r.id = sr.role_id;
