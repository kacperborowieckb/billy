PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`trust_level` text NOT NULL,
	`recorded_at` text NOT NULL,
	`compacted_at` text,
	CONSTRAINT "conversation_messages_kind_check" CHECK("kind" IN ('input', 'step', 'reply', 'write_back', 'approval_status', 'summary')),
	CONSTRAINT "conversation_messages_trust_level_check" CHECK("trust_level" IN ('owner', 'untrusted'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_messages`(`sequence`, `event_id`, `kind`, `message`, `trust_level`, `recorded_at`, `compacted_at`)
SELECT
	`sequence`,
	`event_id`,
	CASE `kind` WHEN 'write_back_stub' THEN 'write_back' ELSE `kind` END,
	`message`,
	CASE `kind` WHEN 'write_back_stub' THEN 'untrusted' ELSE 'owner' END,
	`recorded_at`,
	`compacted_at`
FROM `conversation_messages`;--> statement-breakpoint
DELETE FROM `__new_conversation_messages`
WHERE `sequence` IN (
	SELECT `sequence`
	FROM `conversation_messages`
	WHERE `compacted_at` IS NULL
		AND (
			`kind` = 'write_back_stub'
			OR (
				`kind` = 'reply'
				AND json_extract(`message`, '$.content') = '[Reply sent to the Owner. Text removed from the history]'
			)
		)
);--> statement-breakpoint
DROP TABLE `conversation_messages`;--> statement-breakpoint
ALTER TABLE `__new_conversation_messages` RENAME TO `conversation_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversation_messages_event` ON `conversation_messages` (`event_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_compacted` ON `conversation_messages` (`compacted_at`);
