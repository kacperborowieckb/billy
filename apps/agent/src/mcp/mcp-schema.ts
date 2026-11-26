import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import { mcpConnectionStates } from "../personal-agent/storage-values.ts";

export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    catalogId: text("catalog_id").primaryKey().notNull(),
    state: text("state", { enum: mcpConnectionStates }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "mcp_connections_state_check",
      valueIn(table.state, mcpConnectionStates)
    ),
  ]
);

export const mcpTools = sqliteTable(
  "mcp_tools",
  {
    catalogId: text("catalog_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    inputSchema: text("input_schema").notNull(),
    annotations: text("annotations").notNull(),
  },
  (table) => [primaryKey({ columns: [table.catalogId, table.name] })]
);
