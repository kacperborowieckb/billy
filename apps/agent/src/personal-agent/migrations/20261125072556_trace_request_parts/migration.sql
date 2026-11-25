CREATE TABLE `trace_request_part_uses` (
	`trace_sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`task` text NOT NULL,
	`hash` text NOT NULL,
	CONSTRAINT `trace_request_part_uses_pk` PRIMARY KEY(`trace_sequence`, `kind`),
	CONSTRAINT `fk_trace_request_part_uses_trace_sequence_turn_traces_sequence_fk` FOREIGN KEY (`trace_sequence`) REFERENCES `turn_traces`(`sequence`) ON DELETE CASCADE,
	CONSTRAINT "trace_request_part_uses_kind_check" CHECK("kind" IN ('system', 'tool_definitions', 'owner_context')),
	CONSTRAINT "trace_request_part_uses_task_check" CHECK("task" IN ('reply', 'scheduled_task', 'proactive'))
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `trace_request_part_uses_part` ON `trace_request_part_uses` (`kind`,`task`,`hash`);