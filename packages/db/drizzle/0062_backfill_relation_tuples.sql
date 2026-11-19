-- P-101 ReBAC backfill (part 2): mirror existing rows into
-- relation_tuples for the object-level model.
--   group_members        → group:<id>#member@<kind>:<member_id>
--   patients.owner_id    → patient:<id>#owner@user:<owner_id>
--   consultations.user_id→ consultation:<id>#owner@user:<user_id>
-- Timestamps: group_members.created_at is epoch-ms (timestamp_ms);
-- patients/consultations.created_at is unixepoch SECONDS (timestamp)
-- → *1000. Ids are INTEGER → CAST AS TEXT. consultations.user_id is
-- nullable — NULL-owner rows get no tuple (nothing to attribute).
--> statement-breakpoint
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT 'group', CAST(`group_id` AS TEXT), 'member', `member_kind`, `member_id`, 'allow', NULL, NULL, NULL, `created_at`
FROM `group_members`;--> statement-breakpoint
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT 'patient', CAST(`id` AS TEXT), 'owner', 'user', `owner_id`, 'allow', NULL, NULL, NULL, `created_at` * 1000
FROM `patients`;--> statement-breakpoint
INSERT INTO `relation_tuples` (`object_type`, `object_id`, `relation`, `subject_kind`, `subject_id`, `effect`, `tenant_id`, `expires_at`, `granted_by`, `created_at`)
SELECT 'consultation', CAST(`id` AS TEXT), 'owner', 'user', `user_id`, 'allow', NULL, NULL, NULL, `created_at` * 1000
FROM `consultations` WHERE `user_id` IS NOT NULL;
