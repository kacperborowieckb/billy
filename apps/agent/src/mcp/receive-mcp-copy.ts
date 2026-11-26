import { Effect, Schema } from "effect";

import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import { McpConnections, McpConnectionStateSchema } from "./mcp-connections.ts";
import { McpToolCatalogCopySchema } from "./mcp-tool-copy.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export const receiveMcpToolCatalog = (
  catalog: McpCatalog,
  catalogId: string,
  tools: readonly McpToolCopy[]
) =>
  mcpEntryOf(catalog, catalogId) === undefined
    ? Effect.void
    : Effect.gen(function* receiveToolCatalogEffect() {
        const copy = yield* Schema.decodeUnknownEffect(
          McpToolCatalogCopySchema
        )(tools);
        const connections = yield* McpConnections;
        yield* connections.replaceTools(catalogId, copy);
      }).pipe(Effect.orDie);

export const receiveMcpConnectionState = (
  catalog: McpCatalog,
  catalogId: string,
  state: McpConnectionState
) =>
  mcpEntryOf(catalog, catalogId) === undefined
    ? Effect.void
    : Effect.gen(function* receiveStateEffect() {
        const checked = yield* Schema.decodeUnknownEffect(
          McpConnectionStateSchema
        )(state);
        const connections = yield* McpConnections;
        yield* connections.setState(catalogId, checked);
      }).pipe(Effect.orDie);
