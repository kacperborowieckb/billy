CREATE TABLE `turn_context_blocks` (
	`event_id` text PRIMARY KEY,
	`text` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `conversation_messages`;--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "conversation_messages_kind_check" CHECK("kind" IN ('input', 'step', 'reply', 'approval_status'))
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_event` ON `conversation_messages` (`event_id`);--> statement-breakpoint
DELETE FROM `conversation_recorded_events`;--> statement-breakpoint
DELETE FROM `turn_progress` WHERE `event_id` IN (SELECT `event_id` FROM `inbox_events` WHERE `state` <> 'pending');
