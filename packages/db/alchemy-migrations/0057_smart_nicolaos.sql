CREATE TABLE `schemas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schemas_name_unique` ON `schemas` (`name`);--> statement-breakpoint
CREATE INDEX `schemas_updated_idx` ON `schemas` (`updated_at`);--> statement-breakpoint
ALTER TABLE `custom_pages` ADD `search_schema_id` integer REFERENCES schemas(id);