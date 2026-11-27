ALTER TABLE `orchestration_runs` ADD `tenant_id` integer;--> statement-breakpoint
CREATE INDEX `orchestration_runs_tenant_created_idx` ON `orchestration_runs` (`tenant_id`,`created_at`);