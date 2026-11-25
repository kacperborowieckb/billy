CREATE TABLE `trace_request_parts` (
	`kind` text NOT NULL,
	`task` text NOT NULL,
	`hash` text NOT NULL,
	`content` text NOT NULL,
	`last_used_at` text NOT NULL,
	CONSTRAINT `trace_request_parts_pk` PRIMARY KEY(`kind`, `task`, `hash`),
	CONSTRAINT "trace_request_parts_kind_check" CHECK("kind" IN ('system', 'tool_definitions', 'owner_context')),
	CONSTRAINT "trace_request_parts_task_check" CHECK("task" IN ('reply', 'scheduled_task', 'proactive'))
);
--> statement-breakpoint
CREATE TABLE `trace_retention_runs` (
	`slot` integer PRIMARY KEY,
	`ran_at` text NOT NULL,
	CONSTRAINT "trace_retention_runs_one_row" CHECK("slot" = 0)
);
