CREATE TABLE `prefix_cache_sessions` (
	`task` text PRIMARY KEY NOT NULL,
	`last_call_at_millis` integer NOT NULL,
	`system_hash` text NOT NULL,
	`tools_hash` text NOT NULL,
	`owner_context_hash` text NOT NULL,
	`history_break` text,
	CONSTRAINT "prefix_cache_sessions_task_check" CHECK("task" IN ('reply', 'scheduled_task', 'proactive', 'compaction')),
	CONSTRAINT "prefix_cache_sessions_history_break_check" CHECK("history_break" IS NULL OR "history_break" IN ('compaction', 'stub_in_turn_before'))
);
