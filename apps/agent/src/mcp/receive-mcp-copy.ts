import { Effect, Schema } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { OwnerChannelConversation } from "../personal-agent/owner-channel-conversation.ts";
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

export const connectedMessageOf = (
  displayName: string,
  accountLabel: string | undefined
) =>
  accountLabel === undefined
    ? `Connected ${displayName}`
    : `Connected ${displayName} (account ${accountLabel})`;

export interface McpConnectedCopy {
  readonly catalogId: string;
  readonly tools: readonly McpToolCopy[];
  readonly accountLabel: string | undefined;
}

export const receiveMcpConnected = (
  catalog: McpCatalog,
  { catalogId, tools, accountLabel }: McpConnectedCopy
) => {
  const entry = mcpEntryOf(catalog, catalogId);
  return entry === undefined
    ? Effect.void
    : Effect.gen(function* receiveConnectedEffect() {
        const copy = yield* Schema.decodeUnknownEffect(
          McpToolCatalogCopySchema
        )(tools);
        const connections = yield* McpConnections;
        yield* connections.replaceTools(catalogId, copy);
        yield* connections.setState(catalogId, "ready");
        const journal = yield* Journal;
        yield* journal.append({
          _tag: "McpConnectionAdded",
          eventId: crypto.randomUUID(),
          catalogId,
        });
        const conversation = yield* (yield* OwnerChannelConversation).current;
        if (conversation !== undefined) {
          const channel = yield* Channel;
          yield* channel.send({
            conversationId: conversation.conversationId,
            text: connectedMessageOf(entry.displayName, accountLabel),
          });
        }
      }).pipe(Effect.orDie);
};
