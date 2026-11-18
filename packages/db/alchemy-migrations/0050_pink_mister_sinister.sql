CREATE TABLE `machine` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` integer,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`host` text NOT NULL,
	`port` integer,
	`capabilities` text,
	`secret_ref` text,
	`health_url` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_seen_at` integer,
	`last_check_at` integer,
	`check_error` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_scope_name_idx` ON `machine` (`scope`,`name`);--> statement-breakpoint
CREATE INDEX `machine_tenant_idx` ON `machine` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `machine_status_idx` ON `machine` (`status`);