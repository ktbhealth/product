CREATE TABLE `clinic_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`wrap_public_key` text NOT NULL,
	`sign_public_key` text NOT NULL,
	`wrapped_master_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_keys_tenant_wrap_idx` ON `clinic_keys` (`tenant_id`,`wrap_public_key`);--> statement-breakpoint
CREATE INDEX `clinic_keys_tenant_user_idx` ON `clinic_keys` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `clinic_keys_tenant_status_idx` ON `clinic_keys` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `entity_deks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`reader_kind` text NOT NULL,
	`reader_pubkey` text NOT NULL,
	`reader_id` text,
	`wrapped_dek` text NOT NULL,
	`granted_by_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_deks_record_reader_idx` ON `entity_deks` (`entity_type`,`entity_id`,`reader_pubkey`);--> statement-breakpoint
CREATE INDEX `entity_deks_tenant_record_idx` ON `entity_deks` (`tenant_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `entity_deks_reader_idx` ON `entity_deks` (`reader_pubkey`);--> statement-breakpoint
ALTER TABLE `groups` ADD `zk` integer DEFAULT false NOT NULL;