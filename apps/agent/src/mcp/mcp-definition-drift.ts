import { detectToolDrift } from "ai";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import { mcpPinsOf } from "./mcp-catalog.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";
import { mcpFingerprintsOf } from "./mcp-tool-fingerprint.ts";

export interface McpDefinitionDrift {
  readonly catalogId: string;
  readonly tool: string;
  readonly pinned: string;
  readonly fingerprint: string;
}

export const mcpDefinitionDriftsOf = async (
  entry: McpCatalogEntry,
  tools: readonly McpToolCopy[]
): Promise<readonly McpDefinitionDrift[]> => {
  const fingerprints = await mcpFingerprintsOf(tools);
  const pins = mcpPinsOf(entry);
  return detectToolDrift(fingerprints, pins).changed.map((tool) => ({
    catalogId: entry.catalogId,
    tool,
    pinned: pins[tool] ?? "",
    fingerprint: fingerprints[tool] ?? "",
  }));
};

const recordMcpDefinitionDrift = Effect.fnUntraced(
  function* recordMcpDefinitionDrift({
    catalogId,
    tool,
    pinned,
    fingerprint,
  }: McpDefinitionDrift) {
    const journal = yield* Journal;
    const eventId = `mcp-tool-definition-changed:${catalogId}:${tool}:${pinned}:${fingerprint}`;
    if ((yield* journal.readForEvent(eventId)).length > 0) {
      return;
    }
    yield* journal.append({
      _tag: "McpToolDefinitionChanged",
      eventId,
      catalogId,
      tool,
    });
    yield* Effect.logWarning(
      "MCP tool definition changed",
      JSON.stringify({ catalogId, tool, fingerprint })
    );
  }
);

export const recordMcpDefinitionDrifts = (
  drifts: readonly McpDefinitionDrift[]
) => Effect.forEach(drifts, recordMcpDefinitionDrift, { discard: true });
