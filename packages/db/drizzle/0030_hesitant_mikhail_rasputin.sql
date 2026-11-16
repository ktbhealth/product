ALTER TABLE `eval_llm_endpoint` RENAME TO `ai_endpoint`;--> statement-breakpoint
DROP INDEX `eval_llm_endpoint_enabled_idx`;--> statement-breakpoint
ALTER TABLE `ai_endpoint` ADD `scope` text DEFAULT 'eval' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_endpoint` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_endpoint_enabled_idx` ON `ai_endpoint` (`enabled`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_eval_instance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`endpoint_id` integer,
	`params` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`batch_id` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `ai_endpoint`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_instance`("id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "batch_id", "created_by", "created_at") SELECT "id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "batch_id", "created_by", "created_at" FROM `eval_instance`;--> statement-breakpoint
DROP TABLE `eval_instance`;--> statement-breakpoint
ALTER TABLE `__new_eval_instance` RENAME TO `eval_instance`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `eval_instance_status_idx` ON `eval_instance` (`status`);