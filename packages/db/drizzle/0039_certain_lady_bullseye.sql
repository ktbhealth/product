CREATE TABLE `kv_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`tenant_id` integer,
	`owner_id` text,
	`value` text NOT NULL,
	`expires_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`tenant_key` integer GENERATED ALWAYS AS (coalesce("tenant_id", -1)) VIRTUAL,
	`owner_key` text GENERATED ALWAYS AS (coalesce("owner_id", '')) VIRTUAL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kv_entries_uidx` ON `kv_entries` (`namespace`,`key`,`tenant_key`,`owner_key`);--> statement-breakpoint
CREATE INDEX `kv_entries_expiry_idx` ON `kv_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `kv_entries_scope_idx` ON `kv_entries` (`namespace`,`tenant_id`,`owner_id`);