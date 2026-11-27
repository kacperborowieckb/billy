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

export const McpConnectedCopySchema = Schema.Struct({
  catalogId: Schema.String,
  tools: McpToolCatalogCopySchema,
  accountLabel: Schema.UndefinedOr(Schema.String),
  completionId: Schema.NonEmptyString,
});

export type McpConnectedCopy = typeof McpConnectedCopySchema.Type;

export const receiveMcpConnected = (catalog: McpCatalog, received: unknown) =>
  Effect.gen(function* receiveConnectedEffect() {
    const { catalogId, tools, accountLabel, completionId } =
      yield* Schema.decodeUnknownEffect(McpConnectedCopySchema)(received);
    const entry = mcpEntryOf(catalog, catalogId);
    if (entry === undefined) {
      return;
    }
    const journal = yield* Journal;
    const eventId = `mcp-connection-added:${completionId}`;
    if ((yield* journal.readForEvent(eventId)).length > 0) {
      return;
    }
    const connections = yield* McpConnections;
    yield* connections.replaceTools(catalogId, tools);
    yield* connections.setState(catalogId, "ready");
    yield* journal.append({
      _tag: "McpConnectionAdded",
      eventId,
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
