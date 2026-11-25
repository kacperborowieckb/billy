import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import { historyBreaks, sessionTasks } from "./storage-values.ts";

export const prefixCacheSessions = sqliteTable(
  "prefix_cache_sessions",
  {
    task: text("task", { enum: sessionTasks }).notNull().primaryKey(),
    lastCallAtMillis: integer("last_call_at_millis").notNull(),
    systemHash: text("system_hash").notNull(),
    toolsHash: text("tools_hash").notNull(),
    ownerContextHash: text("owner_context_hash").notNull(),
    historyBreak: text("history_break", { enum: historyBreaks }),
  },
  (table) => [
    check(
      "prefix_cache_sessions_task_check",
      valueIn(table.task, sessionTasks)
    ),
    check(
      "prefix_cache_sessions_history_break_check",
      sql`${table.historyBreak} IS NULL OR ${valueIn(table.historyBreak, historyBreaks)}`
    ),
  ]
);
