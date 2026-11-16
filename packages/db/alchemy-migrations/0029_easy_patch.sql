CREATE TABLE `portal_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`wrap_public_key` text NOT NULL,
	`sign_public_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portal_keys_user_wrap_idx` ON `portal_keys` (`user_id`,`wrap_public_key`);--> statement-breakpoint
CREATE INDEX `portal_keys_wrap_idx` ON `portal_keys` (`wrap_public_key`);