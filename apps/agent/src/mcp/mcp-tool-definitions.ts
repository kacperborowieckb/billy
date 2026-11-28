import { Effect } from "effect";

import { McpConnections } from "./mcp-connections.ts";
import { fingerprintedMcpCopiesOf } from "./mcp-tool-fingerprint.ts";

export const mcpToolDefinitionsOf = Effect.fnUntraced(
  function* mcpToolDefinitionsOf(catalogId: string) {
    const tools = yield* (yield* McpConnections).tools(catalogId);
    const definitions = yield* Effect.promise(() =>
      fingerprintedMcpCopiesOf(tools)
    );
    return definitions.toSorted((left, right) =>
      left.name < right.name ? -1 : 1
    );
  },
  Effect.orDie
);
