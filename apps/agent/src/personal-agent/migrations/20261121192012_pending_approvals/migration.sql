CREATE TABLE `pending_approvals` (
	`pending_approval_id` text PRIMARY KEY,
	`turn_event_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`frozen_input` text NOT NULL,
	`summary` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`channel_message_id` text,
	`result` text,
	CONSTRAINT "pending_approvals_state_check" CHECK("state" IN ('draft', 'pending', 'approved', 'rejected', 'expired', 'executed', 'failed', 'unconfirmed')),
	CONSTRAINT "pending_approvals_draft_check" CHECK("state" <> 'draft' OR ("channel_message_id" IS NULL AND "result" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `pending_approvals_turn` ON `pending_approvals` (`turn_event_id`,`state`);--> statement-breakpoint
CREATE INDEX `pending_approvals_state_expiry` ON `pending_approvals` (`state`,`expires_at`);