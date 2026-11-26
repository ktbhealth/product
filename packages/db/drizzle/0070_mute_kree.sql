CREATE TABLE `orchestration_defs` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`def` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orchestration_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`source` text NOT NULL,
	`ts` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `orchestration_node_runs` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`error` text,
	`fires` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`def_id` text NOT NULL,
	`def_version` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`state` text NOT NULL,
	`runtime` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_def_status_idx` ON `orchestration_runs` (`def_id`,`status`);