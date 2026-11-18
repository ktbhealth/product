CREATE TABLE `ai_prompt` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` integer,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`locale` text DEFAULT '' NOT NULL,
	`template` text NOT NULL,
	`variables` text,
	`model_hint` text,
	`is_system` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompt_scope_name_version_locale_idx` ON `ai_prompt` (`scope`,`name`,`version`,`locale`);--> statement-breakpoint
CREATE INDEX `ai_prompt_tenant_idx` ON `ai_prompt` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `ai_prompt_name_idx` ON `ai_prompt` (`name`);