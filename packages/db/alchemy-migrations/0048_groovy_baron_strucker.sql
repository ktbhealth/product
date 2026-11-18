CREATE TABLE `appointments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`patient_id` integer NOT NULL,
	`tenant_id` integer,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`starts_at` integer NOT NULL,
	`duration_min` integer DEFAULT 30 NOT NULL,
	`consultation_id` integer,
	`note` text,
	`reminder_sent_at` integer,
	`external_provider` text,
	`external_calendar_id` text,
	`external_event_id` text,
	`external_etag` text,
	`sync_state` text DEFAULT 'local' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`consultation_id`) REFERENCES `consultations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `appointments_owner_start_idx` ON `appointments` (`owner_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_reminder_idx` ON `appointments` (`reminder_sent_at`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_tenant_id_idx` ON `appointments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `appointments_patient_idx` ON `appointments` (`patient_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_external_idx` ON `appointments` (`external_provider`,`external_calendar_id`,`external_event_id`);