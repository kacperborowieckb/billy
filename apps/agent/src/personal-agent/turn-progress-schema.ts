import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const turnProgress = sqliteTable(
  "turn_progress",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    message: text("message").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [index("turn_progress_event").on(table.eventId)]
);

export const turnContextBlocks = sqliteTable("turn_context_blocks", {
  eventId: text("event_id").primaryKey(),
  text: text("text").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const turnModelSteps = sqliteTable(
  "turn_model_steps",
  {
    eventId: text("event_id").notNull(),
    modelStepKey: integer("model_step_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.modelStepKey] })]
);
