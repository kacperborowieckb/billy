import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { mcpEntryOf } from "../mcp/mcp-catalog.ts";
import { McpConnections } from "../mcp/mcp-connections.ts";
import { destinationOf } from "./delivery-send.ts";
import type { InboxEvent } from "./inbox.ts";

export const connectButtonFailedText =
  "I could not send the Connect button. Ask me to connect again.";

export const connectEdgePath = (catalogId: string) =>
  `/mcp/connect?c=${encodeURIComponent(catalogId)}`;

export const sendConnectButtons = Effect.fnUntraced(
  function* sendConnectButtons(
    event: InboxEvent,
    replyTo: InboxEvent,
    delivery: "Confirmed" | "Failed" | "Unconfirmed"
  ) {
    const connections = yield* McpConnections;
    const requested = yield* connections.connectRequestsOf(event.eventId);
    if (requested.length === 0) {
      return;
    }
    yield* connections.settleConnectRequests(event.eventId);
    if (delivery !== "Confirmed") {
      return;
    }
    const channel = yield* Channel;
    const destination = yield* destinationOf(replyTo);
    if (destination === undefined) {
      return;
    }
    for (const catalogId of requested) {
      const name = mcpEntryOf(connections.catalog, catalogId)?.displayName;
      if (name === undefined) {
        continue;
      }
      const sent = yield* channel.sendOwnerProofLink({
        conversationId: destination.conversationId,
        text: `Connect ${name}`,
        label: `Connect ${name}`,
        edgePath: connectEdgePath(catalogId),
      });
      if (sent._tag === "Failed") {
        yield* channel.send({
          conversationId: destination.conversationId,
          text: connectButtonFailedText,
        });
      }
    }
  }
);
