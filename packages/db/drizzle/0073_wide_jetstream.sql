DROP INDEX `entity_deks_record_reader_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `entity_deks_record_reader_idx` ON `entity_deks` (`tenant_id`,`entity_type`,`entity_id`,`reader_pubkey`);--> statement-breakpoint
ALTER TABLE `eval_run` ADD `lease_until` integer;