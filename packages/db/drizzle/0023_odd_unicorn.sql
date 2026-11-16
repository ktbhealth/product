CREATE TABLE `credential` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`secret` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
