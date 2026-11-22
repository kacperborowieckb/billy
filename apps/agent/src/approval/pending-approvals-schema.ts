import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import {
  pendingApprovalStates,
  trustLevels,
} from "../personal-agent/storage-values.ts";

export const pendingApprovals = sqliteTable(
  "pending_approvals",
  {
    pendingApprovalId: text("pending_approval_id").primaryKey(),
    position: integer("position").notNull(),
    turnEventId: text("turn_event_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    frozenInput: text("frozen_input").notNull(),
    summary: text("summary").notNull(),
    trustLevel: text("trust_level", { enum: trustLevels })
      .notNull()
      .default("untrusted"),
    state: text("state", { enum: pendingApprovalStates }).notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    channelMessageId: text("channel_message_id"),
    result: text("result"),
  },
  (table) => [
    uniqueIndex("pending_approvals_position").on(table.position),
    index("pending_approvals_turn").on(table.turnEventId, table.state),
    index("pending_approvals_state_expiry").on(table.state, table.expiresAt),
    check(
      "pending_approvals_state_check",
      valueIn(table.state, pendingApprovalStates)
    ),
    check(
      "pending_approvals_trust_level_check",
      valueIn(table.trustLevel, trustLevels)
    ),
    check(
      "pending_approvals_draft_check",
      sql`${table.state} <> 'draft' OR (${table.channelMessageId} IS NULL AND ${table.result} IS NULL)`
    ),
  ]
);
