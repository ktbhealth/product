CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT false,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
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
	`claimed_at` integer,
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
	`transport` text,
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
--> statement-breakpoint
ALTER TABLE `doctors` ADD `synthetic` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `patient_id` integer REFERENCES patients(id);--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `doctor_id` integer REFERENCES doctors(id);--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `script_mode` text;--> statement-breakpoint
ALTER TABLE `patients` ADD `synthetic` integer DEFAULT false NOT NULL;