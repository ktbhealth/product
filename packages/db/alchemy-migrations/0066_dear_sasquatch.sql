CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`payload` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_kind_name_idx` ON `templates` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `templates_updated_idx` ON `templates` (`updated_at`);