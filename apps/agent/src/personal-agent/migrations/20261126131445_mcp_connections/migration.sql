CREATE TABLE `mcp_connections` (
	`catalog_id` text PRIMARY KEY,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "mcp_connections_state_check" CHECK("state" IN ('authenticating', 'ready', 'failed', 'needs_sign_in'))
);
--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`catalog_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema` text NOT NULL,
	`annotations` text NOT NULL,
	CONSTRAINT `mcp_tools_pk` PRIMARY KEY(`catalog_id`, `name`)
);
