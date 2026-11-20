CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`alt` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`storage_key` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `images_created_idx` ON `images` (`created_at`);