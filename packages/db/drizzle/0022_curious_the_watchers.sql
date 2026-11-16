CREATE TABLE `eval_instance` (
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
	FOREIGN KEY (`endpoint_id`) REFERENCES `eval_llm_endpoint`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `eval_instance_status_idx` ON `eval_instance` (`status`);--> statement-breakpoint
CREATE TABLE `eval_instance_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`persona_def_id` integer,
	`eval_persona_id` integer,
	`persona` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `eval_instance`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_def_id`) REFERENCES `eval_persona_def`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`eval_persona_id`) REFERENCES `eval_persona`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `eval_instance_item_instance_idx` ON `eval_instance_item` (`instance_id`);--> statement-breakpoint
CREATE TABLE `eval_llm_endpoint` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text,
	`session_id` text,
	`secret_ref` text,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_llm_endpoint_enabled_idx` ON `eval_llm_endpoint` (`enabled`);--> statement-breakpoint
CREATE TABLE `eval_persona_def` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`persona` text NOT NULL,
	`notes` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer
);
