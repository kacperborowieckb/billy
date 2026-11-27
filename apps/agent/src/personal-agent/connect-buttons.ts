import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { mcpEntryOf } from "../mcp/mcp-catalog.ts";
import { McpConnections } from "../mcp/mcp-connections.ts";
import { McpHubPort } from "../mcp/mcp-hub-contract.ts";
import { destinationOf } from "./delivery-send.ts";
import type { InboxEvent } from "./inbox.ts";
import type { ModelTurnTask } from "./storage-values.ts";

export const connectButtonFailedText =
  "I could not send the Connect button. Ask me to connect again.";

export const connectEdgePath = (catalogId: string, routingId: string) =>
  `/mcp/connect?c=${encodeURIComponent(catalogId)}&r=${encodeURIComponent(routingId)}`;

export const requestReconnectButtons = Effect.fnUntraced(
  function* requestReconnectButtons(task: ModelTurnTask, eventId: string) {
    if (task === "reply") {
      return;
    }
    const connections = yield* McpConnections;
    for (const { catalogId, state } of yield* connections.states) {
      if (state === "needs_sign_in") {
        yield* connections.requestConnect(eventId, catalogId);
      }
    }
  }
);

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
    const hub = yield* McpHubPort;
    const destination = yield* destinationOf(replyTo);
    if (destination === undefined) {
      return;
    }
    for (const catalogId of requested) {
      const name = mcpEntryOf(connections.catalog, catalogId)?.displayName;
      if (name === undefined) {
        continue;
      }
      const verb =
        (yield* connections.stateOf(catalogId)) === "needs_sign_in"
          ? "Reconnect"
          : "Connect";
      const sent = yield* channel.sendOwnerProofLink({
        conversationId: destination.conversationId,
        text: `${verb} ${name}`,
        label: `${verb} ${name}`,
        edgePath: connectEdgePath(catalogId, hub.routingId),
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
