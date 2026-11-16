PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_endpoint` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`model` text,
	`session_id` text,
	`secret_ref` text,
	`transport` text,
	`agent_cmd` text,
	`ssh_host` text,
	`scope` text DEFAULT 'eval' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_ai_endpoint`("id", "name", "kind", "base_url", "model", "session_id", "secret_ref", "transport", "agent_cmd", "ssh_host", "scope", "is_default", "timeout_ms", "enabled", "last_seen_at", "created_at") SELECT "id", "name", "kind", "base_url", "model", "session_id", "secret_ref", "transport", "agent_cmd", "ssh_host", "scope", "is_default", "timeout_ms", "enabled", "last_seen_at", "created_at" FROM `ai_endpoint`;--> statement-breakpoint
DROP TABLE `ai_endpoint`;--> statement-breakpoint
ALTER TABLE `__new_ai_endpoint` RENAME TO `ai_endpoint`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_endpoint_enabled_idx` ON `ai_endpoint` (`enabled`);