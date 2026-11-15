CREATE TABLE `theme_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`theme_id` integer,
	`kind` text NOT NULL,
	`r2_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`variants` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`theme_id`) REFERENCES `theme_definitions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `theme_definitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`app_name` text,
	`seeds` text NOT NULL,
	`tokens` text NOT NULL,
	`fonts` text,
	`brand` text,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theme_definitions_scope_idx` ON `theme_definitions` (`scope`,`scope_id`);