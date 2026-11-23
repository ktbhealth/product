CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`params` text,
	`cron_expr` text,
	`run_at` integer,
	`next_run_at` integer NOT NULL,
	`claimed_until` integer,
	`last_run_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`tenant_id` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_due_idx` ON `scheduled_jobs` (`status`,`next_run_at`);