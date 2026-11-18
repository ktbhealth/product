CREATE TABLE `vault_secret` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` integer,
	`name` text NOT NULL,
	`provider` text,
	`kind` text DEFAULT 'generic' NOT NULL,
	`wrapped_dek` text NOT NULL,
	`ciphertext` text NOT NULL,
	`kek_version` text,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`rotated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secret_scope_name_idx` ON `vault_secret` (`scope`,`name`);--> statement-breakpoint
CREATE INDEX `vault_secret_tenant_idx` ON `vault_secret` (`tenant_id`);