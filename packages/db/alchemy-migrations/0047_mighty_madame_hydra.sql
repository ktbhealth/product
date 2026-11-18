CREATE TABLE `wizard_defs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`definition_json` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wizard_defs_key_idx` ON `wizard_defs` (`key`);--> statement-breakpoint
CREATE TABLE `wizard_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`definition_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
	`answers_json` text DEFAULT '{}' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `wizard_runs_owner_idx` ON `wizard_runs` (`owner_id`,`status`);