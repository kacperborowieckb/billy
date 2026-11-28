import { Effect } from "effect";

import { mcpCatalogToolOf } from "./mcp-catalog.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import { loggedToolNamesOf } from "./mcp-logged-name.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export const mcpToolCatalogLog = (
  entry: McpCatalogEntry,
  tools: readonly McpToolCopy[]
) => {
  const listed = new Set(tools.map(({ name }) => name));
  const namesWhere = (holds: (tool: McpToolCopy) => boolean) =>
    loggedToolNamesOf(tools.filter(holds).map(({ name }) => name));
  return Effect.logInfo(
    "MCP tool catalog",
    JSON.stringify({
      catalogId: entry.catalogId,
      toolCount: tools.length,
      notInCatalog: namesWhere(
        ({ name }) => mcpCatalogToolOf(entry, name) === undefined
      ),
      catalogToolsNotListed: loggedToolNamesOf(
        entry.tools.map(({ name }) => name).filter((name) => !listed.has(name))
      ),
      markedReadOnly: namesWhere(
        ({ annotations }) => annotations.readOnlyHint === true
      ),
      markedDestructive: namesWhere(
        ({ annotations }) => annotations.destructiveHint === true
      ),
    })
  );
};
