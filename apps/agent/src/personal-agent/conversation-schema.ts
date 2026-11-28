import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import { conversationRowKinds, trustLevels } from "./storage-values.ts";

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    kind: text("kind", { enum: conversationRowKinds }).notNull(),
    message: text("message").notNull(),
    trustLevel: text("trust_level", { enum: trustLevels }).notNull(),
    recordedAt: text("recorded_at").notNull(),
    compactedAt: text("compacted_at"),
  },
  (table) => [
    index("conversation_messages_event").on(table.eventId),
    index("conversation_messages_compacted").on(table.compactedAt),
    check(
      "conversation_messages_kind_check",
      valueIn(table.kind, conversationRowKinds)
    ),
    check(
      "conversation_messages_trust_level_check",
      valueIn(table.trustLevel, trustLevels)
    ),
  ]
);

export const refusedCompactionBlocks = sqliteTable(
  "refused_compaction_blocks",
  {
    slot: integer("slot").primaryKey(),
    lastCompactedSequence: integer("last_compacted_sequence").notNull(),
    refusedAt: text("refused_at").notNull(),
  },
  (table) => [
    check("refused_compaction_blocks_one_row", sql`${table.slot} = 0`),
  ]
);

export const conversationRecordedEvents = sqliteTable(
  "conversation_recorded_events",
  { eventId: text("event_id").primaryKey() }
);
