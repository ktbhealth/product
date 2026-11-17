CREATE TABLE `eval_run_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `eval_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `eval_instance_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_run_sample_run_item_idx` ON `eval_run_sample` (`run_id`,`item_id`);--> statement-breakpoint
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
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `ai_endpoint`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_instance`("id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "created_by", "created_at") SELECT "id", "name", "mode", "endpoint_id", "params", "status", "total", "done", "created_by", "created_at" FROM `eval_instance`;--> statement-breakpoint
DROP TABLE `eval_instance`;--> statement-breakpoint
ALTER TABLE `__new_eval_instance` RENAME TO `eval_instance`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `eval_instance_status_idx` ON `eval_instance` (`status`);--> statement-breakpoint
CREATE TABLE `__new_eval_instance_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer NOT NULL,
	`persona_def_id` integer,
	`persona` text,
	`script` text,
	`turns` text,
	`voices` text,
	`patient_id` integer,
	`doctor_id` integer,
	`script_mode` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`state` text DEFAULT 'under_review' NOT NULL,
	`feedback` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `eval_instance`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_def_id`) REFERENCES `eval_persona_def`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`doctor_id`) REFERENCES `doctors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_instance_item`("id", "instance_id", "persona_def_id", "persona", "script", "turns", "voices", "patient_id", "doctor_id", "script_mode", "status", "error", "state", "feedback", "reviewed_by", "reviewed_at", "claimed_at", "created_at") SELECT "id", "instance_id", "persona_def_id", "persona", "script", "turns", "voices", "patient_id", "doctor_id", "script_mode", "status", "error", "state", "feedback", "reviewed_by", "reviewed_at", "claimed_at", "created_at" FROM `eval_instance_item`;--> statement-breakpoint
DROP TABLE `eval_instance_item`;--> statement-breakpoint
ALTER TABLE `__new_eval_instance_item` RENAME TO `eval_instance_item`;--> statement-breakpoint
CREATE INDEX `eval_instance_item_instance_idx` ON `eval_instance_item` (`instance_id`);--> statement-breakpoint
CREATE TABLE `__new_eval_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` integer,
	`params` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`started_at` integer,
	`finished_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `eval_instance`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_eval_run`("id", "instance_id", "params", "status", "total", "done", "summary", "started_at", "finished_at", "created_by", "created_at") SELECT "id", "instance_id", "params", "status", "total", "done", "summary", "started_at", "finished_at", "created_by", "created_at" FROM `eval_run`;--> statement-breakpoint
DROP TABLE `eval_run`;--> statement-breakpoint
ALTER TABLE `__new_eval_run` RENAME TO `eval_run`;--> statement-breakpoint
CREATE INDEX `eval_run_instance_idx` ON `eval_run` (`instance_id`);