PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_account`("id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at") SELECT "id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at" FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT false,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
INSERT INTO `__new_apikey`("id", "config_id", "name", "start", "reference_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata") SELECT "id", "config_id", "name", "start", "reference_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata" FROM `apikey`;--> statement-breakpoint
DROP TABLE `apikey`;--> statement-breakpoint
ALTER TABLE `__new_apikey` RENAME TO `apikey`;--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `__new_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session`("id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id") SELECT "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id" FROM `session`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
ALTER TABLE `__new_session` RENAME TO `session`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`banned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user`("id", "name", "email", "email_verified", "image", "banned", "created_at", "updated_at") SELECT "id", "name", "email", "email_verified", "image", "banned", "created_at", "updated_at" FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `__new_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_verification`("id", "identifier", "value", "expires_at", "created_at", "updated_at") SELECT "id", "identifier", "value", "expires_at", "created_at", "updated_at" FROM `verification`;--> statement-breakpoint
DROP TABLE `verification`;--> statement-breakpoint
ALTER TABLE `__new_verification` RENAME TO `verification`;--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `__new_ai_agent_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `ai_endpoint`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ai_agent_link`("id", "endpoint_id", "token_hash", "created_by", "expires_at", "used_at", "revoked_at", "created_at") SELECT "id", "endpoint_id", "token_hash", "created_by", "expires_at", "used_at", "revoked_at", "created_at" FROM `ai_agent_link`;--> statement-breakpoint
DROP TABLE `ai_agent_link`;--> statement-breakpoint
ALTER TABLE `__new_ai_agent_link` RENAME TO `ai_agent_link`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_agent_link_token_hash_unique` ON `ai_agent_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ai_agent_link_endpoint_idx` ON `ai_agent_link` (`endpoint_id`);--> statement-breakpoint
CREATE TABLE `__new_ai_endpoint` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`model` text,
	`session_id` text,
	`secret_ref` text,
	`transport` text,
	`agent_cmd` text,
	`ssh_host` text,
	`scope` text DEFAULT 'eval' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_ai_endpoint`("id", "name", "kind", "base_url", "model", "session_id", "secret_ref", "transport", "agent_cmd", "ssh_host", "scope", "is_default", "timeout_ms", "enabled", "last_seen_at", "created_at") SELECT "id", "name", "kind", "base_url", "model", "session_id", "secret_ref", "transport", "agent_cmd", "ssh_host", "scope", "is_default", "timeout_ms", "enabled", "last_seen_at", "created_at" FROM `ai_endpoint`;--> statement-breakpoint
DROP TABLE `ai_endpoint`;--> statement-breakpoint
ALTER TABLE `__new_ai_endpoint` RENAME TO `ai_endpoint`;--> statement-breakpoint
CREATE INDEX `ai_endpoint_enabled_idx` ON `ai_endpoint` (`enabled`);--> statement-breakpoint
CREATE TABLE `__new_admin_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`tenant_id` integer,
	`prev_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_admin_audit`("id", "actor_user_id", "actor_email", "action", "target_type", "target_id", "detail", "tenant_id", "prev_hash", "created_at") SELECT "id", "actor_user_id", "actor_email", "action", "target_type", "target_id", "detail", "tenant_id", "prev_hash", "created_at" FROM `admin_audit`;--> statement-breakpoint
DROP TABLE `admin_audit`;--> statement-breakpoint
ALTER TABLE `__new_admin_audit` RENAME TO `admin_audit`;--> statement-breakpoint
CREATE INDEX `admin_audit_created_at_idx` ON `admin_audit` (`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_action_idx` ON `admin_audit` (`action`);--> statement-breakpoint
CREATE INDEX `admin_audit_actor_idx` ON `admin_audit` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_tenant_created_idx` ON `admin_audit` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_dedupe_idx` ON `admin_audit` (`actor_user_id`,`action`,`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_doctors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`crm` text,
	`specialty` text,
	`synthetic` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_doctors`("id", "user_id", "display_name", "crm", "specialty", "synthetic", "created_at", "updated_at") SELECT "id", "user_id", "display_name", "crm", "specialty", "synthetic", "created_at", "updated_at" FROM `doctors`;--> statement-breakpoint
DROP TABLE `doctors`;--> statement-breakpoint
ALTER TABLE `__new_doctors` RENAME TO `doctors`;--> statement-breakpoint
CREATE UNIQUE INDEX `doctors_user_id_unique` ON `doctors` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_eval_instance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`endpoint_id` integer,
	`params` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`batch_id` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `ai_endpoint`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_instance`("id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "batch_id", "created_by", "created_at") SELECT "id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "batch_id", "created_by", "created_at" FROM `eval_instance`;--> statement-breakpoint
DROP TABLE `eval_instance`;--> statement-breakpoint
ALTER TABLE `__new_eval_instance` RENAME TO `eval_instance`;--> statement-breakpoint
CREATE INDEX `eval_instance_status_idx` ON `eval_instance` (`status`);--> statement-breakpoint
CREATE TABLE `__new_eval_instance_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`persona_def_id` integer,
	`eval_persona_id` integer,
	`persona` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `eval_instance`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_def_id`) REFERENCES `eval_persona_def`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`eval_persona_id`) REFERENCES `eval_persona`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_instance_item`("id", "instance_id", "persona_def_id", "eval_persona_id", "persona", "status", "error", "claimed_at", "created_at") SELECT "id", "instance_id", "persona_def_id", "eval_persona_id", "persona", "status", "error", "claimed_at", "created_at" FROM `eval_instance_item`;--> statement-breakpoint
DROP TABLE `eval_instance_item`;--> statement-breakpoint
ALTER TABLE `__new_eval_instance_item` RENAME TO `eval_instance_item`;--> statement-breakpoint
CREATE INDEX `eval_instance_item_instance_idx` ON `eval_instance_item` (`instance_id`);--> statement-breakpoint
CREATE TABLE `__new_eval_persona_def` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`persona` text NOT NULL,
	`notes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_eval_persona_def`("id", "name", "persona", "notes", "created_by", "created_at", "updated_at") SELECT "id", "name", "persona", "notes", "created_by", "created_at", "updated_at" FROM `eval_persona_def`;--> statement-breakpoint
DROP TABLE `eval_persona_def`;--> statement-breakpoint
ALTER TABLE `__new_eval_persona_def` RENAME TO `eval_persona_def`;--> statement-breakpoint
CREATE TABLE `__new_eval_persona` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`persona` text NOT NULL,
	`script` text NOT NULL,
	`turns` text NOT NULL,
	`voices` text NOT NULL,
	`patient_id` integer,
	`doctor_id` integer,
	`script_mode` text,
	`state` text DEFAULT 'under_review' NOT NULL,
	`feedback` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`doctor_id`) REFERENCES `doctors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_persona`("id", "batch_id", "persona", "script", "turns", "voices", "patient_id", "doctor_id", "script_mode", "state", "feedback", "reviewed_by", "reviewed_at", "created_at") SELECT "id", "batch_id", "persona", "script", "turns", "voices", "patient_id", "doctor_id", "script_mode", "state", "feedback", "reviewed_by", "reviewed_at", "created_at" FROM `eval_persona`;--> statement-breakpoint
DROP TABLE `eval_persona`;--> statement-breakpoint
ALTER TABLE `__new_eval_persona` RENAME TO `eval_persona`;--> statement-breakpoint
CREATE INDEX `eval_persona_batch_idx` ON `eval_persona` (`batch_id`);--> statement-breakpoint
CREATE INDEX `eval_persona_state_idx` ON `eval_persona` (`state`);--> statement-breakpoint
CREATE TABLE `__new_eval_persona_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`params` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_eval_persona_batch`("id", "params", "created_by", "created_at") SELECT "id", "params", "created_by", "created_at" FROM `eval_persona_batch`;--> statement-breakpoint
DROP TABLE `eval_persona_batch`;--> statement-breakpoint
ALTER TABLE `__new_eval_persona_batch` RENAME TO `eval_persona_batch`;--> statement-breakpoint
CREATE INDEX `eval_persona_batch_created_at_idx` ON `eval_persona_batch` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_eval_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_eval_run`("id", "batch_id", "status", "total", "done", "summary", "started_at", "finished_at", "created_at") SELECT "id", "batch_id", "status", "total", "done", "summary", "started_at", "finished_at", "created_at" FROM `eval_run`;--> statement-breakpoint
DROP TABLE `eval_run`;--> statement-breakpoint
ALTER TABLE `__new_eval_run` RENAME TO `eval_run`;--> statement-breakpoint
CREATE INDEX `eval_run_batch_idx` ON `eval_run` (`batch_id`);--> statement-breakpoint
CREATE TABLE `__new_eval_run_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`persona_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `eval_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `eval_persona`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_eval_run_sample`("id", "run_id", "persona_id", "status", "result", "error", "created_at") SELECT "id", "run_id", "persona_id", "status", "result", "error", "created_at" FROM `eval_run_sample`;--> statement-breakpoint
DROP TABLE `eval_run_sample`;--> statement-breakpoint
ALTER TABLE `__new_eval_run_sample` RENAME TO `eval_run_sample`;--> statement-breakpoint
CREATE UNIQUE INDEX `eval_run_sample_run_persona_idx` ON `eval_run_sample` (`run_id`,`persona_id`);--> statement-breakpoint
CREATE TABLE `__new_group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`member_kind` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_group_members`("id", "group_id", "member_kind", "member_id", "role", "created_at") SELECT "id", "group_id", "member_kind", "member_id", "role", "created_at" FROM `group_members`;--> statement-breakpoint
DROP TABLE `group_members`;--> statement-breakpoint
ALTER TABLE `__new_group_members` RENAME TO `group_members`;--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_group_member_idx` ON `group_members` (`group_id`,`member_kind`,`member_id`);--> statement-breakpoint
CREATE TABLE `__new_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`zk` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_groups`("id", "name", "slug", "kind", "meta", "created_at", "updated_at", "zk") SELECT "id", "name", "slug", "kind", "meta", "created_at", "updated_at", "zk" FROM `groups`;--> statement-breakpoint
DROP TABLE `groups`;--> statement-breakpoint
ALTER TABLE `__new_groups` RENAME TO `groups`;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_unique` ON `groups` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_record_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`signature` text,
	`prev_hash` text,
	`payload` text NOT NULL,
	`blob_hash` text NOT NULL,
	`actor_user_id` text,
	`engine` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_record_versions`("id", "entity_type", "entity_id", "version", "content_hash", "signature", "prev_hash", "payload", "blob_hash", "actor_user_id", "engine", "created_at") SELECT "id", "entity_type", "entity_id", "version", "content_hash", "signature", "prev_hash", "payload", "blob_hash", "actor_user_id", "engine", "created_at" FROM `record_versions`;--> statement-breakpoint
DROP TABLE `record_versions`;--> statement-breakpoint
ALTER TABLE `__new_record_versions` RENAME TO `record_versions`;--> statement-breakpoint
CREATE INDEX `record_versions_entity_idx` ON `record_versions` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `record_versions_entity_version_idx` ON `record_versions` (`entity_type`,`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `__new_invite_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`kind` text NOT NULL,
	`inviter_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_invite_tokens`("id", "token_hash", "email", "kind", "inviter_name", "expires_at", "consumed_at", "created_at") SELECT "id", "token_hash", "email", "kind", "inviter_name", "expires_at", "consumed_at", "created_at" FROM `invite_tokens`;--> statement-breakpoint
DROP TABLE `invite_tokens`;--> statement-breakpoint
ALTER TABLE `__new_invite_tokens` RENAME TO `invite_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `invite_tokens_token_hash_unique` ON `invite_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_tokens_email_idx` ON `invite_tokens` (`email`);--> statement-breakpoint
CREATE TABLE `__new_custom_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`show_in_nav` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_custom_pages`("id", "path", "title", "content", "published", "show_in_nav", "sort_order", "created_at", "updated_at") SELECT "id", "path", "title", "content", "published", "show_in_nav", "sort_order", "created_at", "updated_at" FROM `custom_pages`;--> statement-breakpoint
DROP TABLE `custom_pages`;--> statement-breakpoint
ALTER TABLE `__new_custom_pages` RENAME TO `custom_pages`;--> statement-breakpoint
CREATE UNIQUE INDEX `custom_pages_path_idx` ON `custom_pages` (`path`);--> statement-breakpoint
CREATE INDEX `custom_pages_nav_idx` ON `custom_pages` (`published`,`show_in_nav`);--> statement-breakpoint
CREATE TABLE `__new_patient_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`patient_id` integer NOT NULL,
	`user_id` text,
	`email` text,
	`relation` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`granted_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_patient_access`("id", "patient_id", "user_id", "email", "relation", "status", "source", "granted_by", "created_at", "updated_at") SELECT "id", "patient_id", "user_id", "email", "relation", "status", "source", "granted_by", "created_at", "updated_at" FROM `patient_access`;--> statement-breakpoint
DROP TABLE `patient_access`;--> statement-breakpoint
ALTER TABLE `__new_patient_access` RENAME TO `patient_access`;--> statement-breakpoint
CREATE UNIQUE INDEX `patient_access_patient_user_idx` ON `patient_access` (`patient_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `patient_access_user_idx` ON `patient_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `patient_access_email_idx` ON `patient_access` (`email`);--> statement-breakpoint
CREATE TABLE `__new_patient_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`patient_id` integer NOT NULL,
	`type` text NOT NULL,
	`country` text,
	`number` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_patient_documents`("id", "patient_id", "type", "country", "number", "created_at") SELECT "id", "patient_id", "type", "country", "number", "created_at" FROM `patient_documents`;--> statement-breakpoint
DROP TABLE `patient_documents`;--> statement-breakpoint
ALTER TABLE `__new_patient_documents` RENAME TO `patient_documents`;--> statement-breakpoint
CREATE UNIQUE INDEX `patient_documents_patient_type_idx` ON `patient_documents` (`patient_id`,`type`);--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_id` integer NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`effect` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("id", "role_id", "resource", "action", "effect", "created_at") SELECT "id", "role_id", "resource", "action", "effect", "created_at" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_role_resource_action_idx` ON `role_permissions` (`role_id`,`resource`,`action`);--> statement-breakpoint
CREATE TABLE `__new_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`meta` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_roles`("id", "name", "description", "meta", "created_at", "updated_at") SELECT "id", "name", "description", "meta", "created_at", "updated_at" FROM `roles`;--> statement-breakpoint
DROP TABLE `roles`;--> statement-breakpoint
ALTER TABLE `__new_roles` RENAME TO `roles`;--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `__new_subject_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`role_id` integer NOT NULL,
	`tenant_id` text,
	`granted_by` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_subject_roles`("id", "subject_kind", "subject_id", "role_id", "tenant_id", "granted_by", "expires_at", "created_at") SELECT "id", "subject_kind", "subject_id", "role_id", "tenant_id", "granted_by", "expires_at", "created_at" FROM `subject_roles`;--> statement-breakpoint
DROP TABLE `subject_roles`;--> statement-breakpoint
ALTER TABLE `__new_subject_roles` RENAME TO `subject_roles`;--> statement-breakpoint
CREATE INDEX `subject_roles_subject_idx` ON `subject_roles` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `__new_doctor_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doctor_id` integer NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`role` text DEFAULT 'secretary' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`doctor_id`) REFERENCES `doctors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_doctor_access`("id", "doctor_id", "user_id", "email", "role", "status", "invited_by", "created_at", "updated_at") SELECT "id", "doctor_id", "user_id", "email", "role", "status", "invited_by", "created_at", "updated_at" FROM `doctor_access`;--> statement-breakpoint
DROP TABLE `doctor_access`;--> statement-breakpoint
ALTER TABLE `__new_doctor_access` RENAME TO `doctor_access`;--> statement-breakpoint
CREATE UNIQUE INDEX `doctor_access_doctor_email_idx` ON `doctor_access` (`doctor_id`,`email`);--> statement-breakpoint
CREATE INDEX `doctor_access_user_idx` ON `doctor_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `doctor_access_email_idx` ON `doctor_access` (`email`);--> statement-breakpoint
CREATE TABLE `__new_clinic_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`wrap_public_key` text NOT NULL,
	`sign_public_key` text NOT NULL,
	`wrapped_master_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_clinic_keys`("id", "tenant_id", "user_id", "wrap_public_key", "sign_public_key", "wrapped_master_key", "status", "approved_by_user_id", "approved_at", "created_at") SELECT "id", "tenant_id", "user_id", "wrap_public_key", "sign_public_key", "wrapped_master_key", "status", "approved_by_user_id", "approved_at", "created_at" FROM `clinic_keys`;--> statement-breakpoint
DROP TABLE `clinic_keys`;--> statement-breakpoint
ALTER TABLE `__new_clinic_keys` RENAME TO `clinic_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_keys_tenant_wrap_idx` ON `clinic_keys` (`tenant_id`,`wrap_public_key`);--> statement-breakpoint
CREATE INDEX `clinic_keys_tenant_user_idx` ON `clinic_keys` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `clinic_keys_tenant_status_idx` ON `clinic_keys` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_entity_deks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`reader_kind` text NOT NULL,
	`reader_pubkey` text NOT NULL,
	`reader_id` text,
	`wrapped_dek` text NOT NULL,
	`granted_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_entity_deks`("id", "tenant_id", "entity_type", "entity_id", "reader_kind", "reader_pubkey", "reader_id", "wrapped_dek", "granted_by_user_id", "created_at") SELECT "id", "tenant_id", "entity_type", "entity_id", "reader_kind", "reader_pubkey", "reader_id", "wrapped_dek", "granted_by_user_id", "created_at" FROM `entity_deks`;--> statement-breakpoint
DROP TABLE `entity_deks`;--> statement-breakpoint
ALTER TABLE `__new_entity_deks` RENAME TO `entity_deks`;--> statement-breakpoint
CREATE UNIQUE INDEX `entity_deks_record_reader_idx` ON `entity_deks` (`entity_type`,`entity_id`,`reader_pubkey`);--> statement-breakpoint
CREATE INDEX `entity_deks_tenant_record_idx` ON `entity_deks` (`tenant_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `entity_deks_reader_idx` ON `entity_deks` (`reader_pubkey`);--> statement-breakpoint
CREATE TABLE `__new_portal_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`wrap_public_key` text NOT NULL,
	`sign_public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_portal_keys`("id", "user_id", "wrap_public_key", "sign_public_key", "created_at") SELECT "id", "user_id", "wrap_public_key", "sign_public_key", "created_at" FROM `portal_keys`;--> statement-breakpoint
DROP TABLE `portal_keys`;--> statement-breakpoint
ALTER TABLE `__new_portal_keys` RENAME TO `portal_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `portal_keys_user_wrap_idx` ON `portal_keys` (`user_id`,`wrap_public_key`);--> statement-breakpoint
CREATE INDEX `portal_keys_wrap_idx` ON `portal_keys` (`wrap_public_key`);