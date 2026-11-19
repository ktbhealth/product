CREATE TABLE `layouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `layouts_name_unique` ON `layouts` (`name`);--> statement-breakpoint
CREATE INDEX `layouts_updated_idx` ON `layouts` (`updated_at`);--> statement-breakpoint
ALTER TABLE `custom_pages` ADD `layout_id` integer REFERENCES layouts(id);