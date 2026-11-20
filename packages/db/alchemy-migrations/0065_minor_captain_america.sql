ALTER TABLE `custom_pages` RENAME TO `pages`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`rich_text_id` integer,
	`search_schema_id` integer,
	`layout_id` integer,
	`published` integer DEFAULT false NOT NULL,
	`show_in_nav` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`rich_text_id`) REFERENCES `rich_text`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`search_schema_id`) REFERENCES `schemas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pages`("id", "path", "title", "rich_text_id", "search_schema_id", "layout_id", "published", "show_in_nav", "sort_order", "created_at", "updated_at") SELECT "id", "path", "title", "rich_text_id", "search_schema_id", "layout_id", "published", "show_in_nav", "sort_order", "created_at", "updated_at" FROM `pages`;--> statement-breakpoint
DROP TABLE `pages`;--> statement-breakpoint
ALTER TABLE `__new_pages` RENAME TO `pages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pages_path_idx` ON `pages` (`path`);--> statement-breakpoint
CREATE INDEX `pages_nav_idx` ON `pages` (`published`,`show_in_nav`);