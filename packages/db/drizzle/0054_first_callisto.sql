CREATE TABLE `eval_run_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`item_id` integer,
	`stage` text NOT NULL,
	`engine` text NOT NULL,
	`model` text,
	`started_at` integer,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `eval_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_run_record_run_idx` ON `eval_run_record` (`run_id`);--> statement-breakpoint
ALTER TABLE `consultations` ADD `synthetic` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `consultations` ADD `eval_item_id` integer;--> statement-breakpoint
ALTER TABLE `eval_instance` ADD `manifest` text;--> statement-breakpoint
ALTER TABLE `eval_run` ADD `experiment` text;