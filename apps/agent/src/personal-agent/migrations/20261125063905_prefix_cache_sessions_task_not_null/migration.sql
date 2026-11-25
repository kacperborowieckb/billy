CREATE TABLE `prefix_cache_sessions_new` (
	`task` text PRIMARY KEY NOT NULL,
	`last_call_at_millis` integer NOT NULL,
	`system_hash` text NOT NULL,
	`tools_hash` text NOT NULL,
	`owner_context_hash` text NOT NULL,
	`history_break` text,
	CONSTRAINT "prefix_cache_sessions_task_check" CHECK("task" IN ('reply', 'scheduled_task', 'proactive', 'compaction')),
	CONSTRAINT "prefix_cache_sessions_history_break_check" CHECK("history_break" IS NULL OR "history_break" IN ('compaction', 'stub_in_turn_before'))
);
--> statement-breakpoint
INSERT INTO `prefix_cache_sessions_new` SELECT * FROM `prefix_cache_sessions` WHERE `task` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `prefix_cache_sessions`;
--> statement-breakpoint
ALTER TABLE `prefix_cache_sessions_new` RENAME TO `prefix_cache_sessions`;
