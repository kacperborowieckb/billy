CREATE TABLE `write_back_markers` (
	`event_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`local_time` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "write_back_markers_kind_check" CHECK("kind" IN ('Brief', 'Follow-up', 'Scheduled Task', 'Reminder', 'Schedule'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "conversation_messages_kind_check" CHECK("kind" IN ('input', 'step', 'reply', 'write_back', 'write_back_stub', 'approval_status'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_messages`(`sequence`, `event_id`, `kind`, `message`, `recorded_at`) SELECT `sequence`, `event_id`, `kind`, `message`, `recorded_at` FROM `conversation_messages`;--> statement-breakpoint
DROP TABLE `conversation_messages`;--> statement-breakpoint
ALTER TABLE `__new_conversation_messages` RENAME TO `conversation_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversation_messages_event` ON `conversation_messages` (`event_id`);