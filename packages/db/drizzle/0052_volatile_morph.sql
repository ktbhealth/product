CREATE TABLE `ai_model` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` integer,
	`endpoint_id` integer,
	`name` text NOT NULL,
	`model_id` text NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`capabilities` text,
	`context_tokens` integer,
	`cost_tier` text,
	`is_default` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_model_scope_name_idx` ON `ai_model` (`scope`,`name`);--> statement-breakpoint
CREATE INDEX `ai_model_tenant_idx` ON `ai_model` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `ai_model_endpoint_idx` ON `ai_model` (`endpoint_id`);--> statement-breakpoint
CREATE INDEX `ai_model_kind_idx` ON `ai_model` (`kind`);