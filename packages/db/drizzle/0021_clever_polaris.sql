CREATE TABLE `eval_persona` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`persona` text NOT NULL,
	`script` text NOT NULL,
	`turns` text NOT NULL,
	`voices` text NOT NULL,
	`state` text DEFAULT 'under_review' NOT NULL,
	`feedback` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_persona_batch_idx` ON `eval_persona` (`batch_id`);--> statement-breakpoint
CREATE INDEX `eval_persona_state_idx` ON `eval_persona` (`state`);--> statement-breakpoint
CREATE TABLE `eval_persona_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text DEFAULT 'generated' NOT NULL,
	`params` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_persona_batch_created_at_idx` ON `eval_persona_batch` (`created_at`);--> statement-breakpoint
CREATE TABLE `eval_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `eval_persona_batch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_run_batch_idx` ON `eval_run` (`batch_id`);--> statement-breakpoint
CREATE TABLE `eval_run_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`persona_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `eval_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `eval_persona`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_run_sample_run_persona_idx` ON `eval_run_sample` (`run_id`,`persona_id`);
