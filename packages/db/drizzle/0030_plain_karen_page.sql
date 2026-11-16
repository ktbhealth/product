CREATE TABLE `i18n_crdt_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`update` blob NOT NULL,
	`actor_id` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `i18n_crdt_msg_idx` ON `i18n_crdt_updates` (`namespace`,`key`,`locale`,`scope`,`scope_id`);--> statement-breakpoint
CREATE TABLE `i18n_locales` (
	`code` text PRIMARY KEY NOT NULL,
	`endonym` text NOT NULL,
	`fallbacks` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `i18n_messages` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`value` text NOT NULL,
	`draft_value` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`params` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`namespace`, `key`, `locale`, `scope`, `scope_id`)
);
--> statement-breakpoint
CREATE INDEX `i18n_messages_ns_locale_idx` ON `i18n_messages` (`namespace`,`locale`);--> statement-breakpoint
CREATE TABLE `i18n_namespaces` (
	`namespace` text PRIMARY KEY NOT NULL,
	`plugin_id` text DEFAULT '' NOT NULL,
	`manifest_hash` text DEFAULT '' NOT NULL,
	`default_locale` text DEFAULT 'en' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
