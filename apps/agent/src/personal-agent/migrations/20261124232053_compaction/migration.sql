ALTER TABLE `conversation_messages` ADD `compacted_at` text;--> statement-breakpoint
ALTER TABLE `model_usage` ADD `event_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL,
	`compacted_at` text,
	CONSTRAINT "conversation_messages_kind_check" CHECK("kind" IN ('input', 'step', 'reply', 'approval_status', 'summary'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_messages`(`sequence`, `event_id`, `kind`, `message`, `recorded_at`) SELECT `sequence`, `event_id`, `kind`, `message`, `recorded_at` FROM `conversation_messages`;--> statement-breakpoint
DROP TABLE `conversation_messages`;--> statement-breakpoint
ALTER TABLE `__new_conversation_messages` RENAME TO `conversation_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversation_messages_event` ON `conversation_messages` (`event_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_compacted` ON `conversation_messages` (`compacted_at`);--> statement-breakpoint
CREATE INDEX `model_usage_event` ON `model_usage` (`event_id`);