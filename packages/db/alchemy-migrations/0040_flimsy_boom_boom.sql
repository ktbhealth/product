CREATE TABLE `document_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner_plugin_id` text DEFAULT '' NOT NULL,
	`schema_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_collections_name_idx` ON `document_collections` (`name`);--> statement-breakpoint
CREATE TABLE `document_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`data` text NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`tenant_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `document_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `document_records_collection_idx` ON `document_records` (`collection_id`);--> statement-breakpoint
CREATE INDEX `document_records_collection_owner_idx` ON `document_records` (`collection_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `document_records_collection_tenant_idx` ON `document_records` (`collection_id`,`tenant_id`);