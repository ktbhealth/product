ALTER TABLE `document_records` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `document_records` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `document_records_idempotency_idx` ON `document_records` (`collection_id`,`idempotency_key`);