ALTER TABLE `pending_approvals` ADD `trust_level` text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_approvals` (
	`pending_approval_id` text PRIMARY KEY,
	`turn_event_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`frozen_input` text NOT NULL,
	`summary` text NOT NULL,
	`trust_level` text DEFAULT 'untrusted' NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`channel_message_id` text,
	`result` text,
	CONSTRAINT "pending_approvals_state_check" CHECK("state" IN ('draft', 'pending', 'approved', 'rejected', 'expired', 'executed', 'failed', 'unconfirmed')),
	CONSTRAINT "pending_approvals_trust_level_check" CHECK("trust_level" IN ('owner', 'untrusted')),
	CONSTRAINT "pending_approvals_draft_check" CHECK("state" <> 'draft' OR ("channel_message_id" IS NULL AND "result" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_pending_approvals`(`pending_approval_id`, `turn_event_id`, `tool_call_id`, `tool_name`, `frozen_input`, `summary`, `state`, `created_at`, `expires_at`, `channel_message_id`, `result`) SELECT `pending_approval_id`, `turn_event_id`, `tool_call_id`, `tool_name`, `frozen_input`, `summary`, `state`, `created_at`, `expires_at`, `channel_message_id`, `result` FROM `pending_approvals`;--> statement-breakpoint
DROP TABLE `pending_approvals`;--> statement-breakpoint
ALTER TABLE `__new_pending_approvals` RENAME TO `pending_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `pending_approvals_turn` ON `pending_approvals` (`turn_event_id`,`state`);--> statement-breakpoint
CREATE INDEX `pending_approvals_state_expiry` ON `pending_approvals` (`state`,`expires_at`);