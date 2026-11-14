CREATE TABLE `invite_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`kind` text NOT NULL,
	`inviter_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_tokens_token_hash_unique` ON `invite_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_tokens_email_idx` ON `invite_tokens` (`email`);