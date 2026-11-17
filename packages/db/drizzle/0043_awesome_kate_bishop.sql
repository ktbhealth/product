ALTER TABLE `eval_instance_item` ADD `script` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `turns` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `voices` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `patient_id` integer;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `doctor_id` integer;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `script_mode` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `state` text DEFAULT 'under_review' NOT NULL;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `feedback` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `eval_instance_item` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `eval_run` ADD `instance_id` integer;--> statement-breakpoint
ALTER TABLE `eval_run` ADD `params` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `eval_run` ADD `created_by` text;