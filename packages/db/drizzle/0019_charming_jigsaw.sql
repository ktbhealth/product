CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload_ref` text,
	`error` text,
	`tenant_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_kind_status_idx` ON `job_runs` (`kind`,`status`);