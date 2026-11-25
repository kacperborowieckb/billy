import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import {
  modelTurnTasks,
  requestPartKinds,
} from "../personal-agent/storage-values.ts";

export const traceRequestParts = sqliteTable(
  "trace_request_parts",
  {
    kind: text("kind", { enum: requestPartKinds }).notNull(),
    task: text("task", { enum: modelTurnTasks }).notNull(),
    hash: text("hash").notNull(),
    content: text("content").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.task, table.hash] }),
    check(
      "trace_request_parts_kind_check",
      valueIn(table.kind, requestPartKinds)
    ),
    check(
      "trace_request_parts_task_check",
      valueIn(table.task, modelTurnTasks)
    ),
  ]
);

export const traceRetentionRuns = sqliteTable(
  "trace_retention_runs",
  {
    slot: integer("slot").primaryKey(),
    ranAt: text("ran_at").notNull(),
  },
  (table) => [check("trace_retention_runs_one_row", sql`${table.slot} = 0`)]
);
