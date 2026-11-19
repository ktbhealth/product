CREATE TABLE `rich_text` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rich_text_updated_idx` ON `rich_text` (`updated_at`);--> statement-breakpoint
ALTER TABLE `custom_pages` ADD `rich_text_id` integer REFERENCES rich_text(id);--> statement-breakpoint
ALTER TABLE `custom_pages` DROP COLUMN `content`;