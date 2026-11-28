CREATE TABLE `calendar_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`tenant_id` integer,
	`provider` text NOT NULL,
	`external_calendar_id` text DEFAULT 'primary' NOT NULL,
	`external_account_id` text,
	`credential_ref` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sync_token` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `calendar_connections_owner_idx` ON `calendar_connections` (`owner_id`,`provider`);--> statement-breakpoint
CREATE INDEX `calendar_connections_tenant_id_idx` ON `calendar_connections` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_connections_owner_provider_calendar_idx` ON `calendar_connections` (`owner_id`,`provider`,`external_calendar_id`);