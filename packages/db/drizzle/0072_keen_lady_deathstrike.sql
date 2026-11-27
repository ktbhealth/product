ALTER TABLE `consultations` ADD `transcript_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `consultations` ADD `transcript_reviewed_by` text;--> statement-breakpoint
ALTER TABLE `consultations` ADD `anamnesis_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `consultations` ADD `anamnesis_reviewed_by` text;--> statement-breakpoint
ALTER TABLE `consultations` ADD `anamnesis_reviewed_version` integer;--> statement-breakpoint
ALTER TABLE `consultations` ADD `deferred_until` integer;