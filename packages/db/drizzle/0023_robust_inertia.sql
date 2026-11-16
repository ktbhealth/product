ALTER TABLE `doctors` ADD `synthetic` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `patient_id` integer REFERENCES patients(id);--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `doctor_id` integer REFERENCES doctors(id);--> statement-breakpoint
ALTER TABLE `eval_persona` ADD `script_mode` text;--> statement-breakpoint
ALTER TABLE `patients` ADD `synthetic` integer DEFAULT false NOT NULL;