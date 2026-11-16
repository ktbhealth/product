CREATE TABLE `record_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`signature` text,
	`prev_hash` text,
	`payload` text NOT NULL,
	`blob_hash` text NOT NULL,
	`actor_user_id` text,
	`engine` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `record_versions_entity_idx` ON `record_versions` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `record_versions_entity_version_idx` ON `record_versions` (`entity_type`,`entity_id`,`version`);--> statement-breakpoint
ALTER TABLE `consultations` ADD `anamnesis_hash` text;--> statement-breakpoint
ALTER TABLE `consultations` ADD `anamnesis_version` integer;--> statement-breakpoint
ALTER TABLE `consultations` ADD `blob_hash` text;