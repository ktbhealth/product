CREATE TABLE `ai_agent_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `ai_endpoint`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_agent_link_token_hash_unique` ON `ai_agent_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ai_agent_link_endpoint_idx` ON `ai_agent_link` (`endpoint_id`);--> statement-breakpoint
ALTER TABLE `ai_endpoint` ADD `last_seen_at` integer;