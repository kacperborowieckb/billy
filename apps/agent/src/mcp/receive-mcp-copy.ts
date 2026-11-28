import { Cause, Effect, Schema } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { OwnerChannelConversation } from "../personal-agent/owner-channel-conversation.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import { Schedules } from "../schedule/schedules.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import { McpConnections, McpConnectionStateSchema } from "./mcp-connections.ts";
import {
  mcpDefinitionDriftsOf,
  recordMcpDefinitionDrifts,
} from "./mcp-definition-drift.ts";
import { makeApprovalsOfConnectionDue } from "./mcp-disconnect-approvals.ts";
import {
  failureReasonOf,
  mcpFailureLog,
  toolCopySizeOf,
} from "./mcp-failure.ts";
import type { McpFailure } from "./mcp-failure.ts";
import type { McpRevocation } from "./mcp-hub-contract.ts";
import { mcpToolCatalogLog } from "./mcp-tool-catalog-log.ts";
import { McpToolCatalogCopySchema } from "./mcp-tool-copy.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export const receiveMcpToolCatalog = (
  catalog: McpCatalog,
  catalogId: string,
  tools: readonly McpToolCopy[]
) => {
  const entry = mcpEntryOf(catalog, catalogId);
  return entry === undefined
    ? Effect.void
    : Effect.gen(function* receiveToolCatalogEffect() {
        const copy = yield* Schema.decodeUnknownEffect(
          McpToolCatalogCopySchema
        )(tools);
        const drifts = yield* Effect.promise(() =>
          mcpDefinitionDriftsOf(entry, copy)
        );
        const { database } = yield* AgentStorage;
        const connections = yield* McpConnections;
        yield* database.transaction(() =>
          connections
            .replaceTools(catalogId, copy)
            .pipe(Effect.andThen(recordMcpDefinitionDrifts(drifts)))
        );
        yield* mcpToolCatalogLog(entry, copy);
      }).pipe(Effect.orDie);
};

export const changeMcpConnectionState = Effect.fnUntraced(
  function* changeMcpConnectionState(
    catalogId: string,
    state: McpConnectionState
  ) {
    const connections = yield* McpConnections;
    if ((yield* connections.stateOf(catalogId)) === state) {
      return;
    }
    yield* connections.setState(catalogId, state);
    yield* (yield* Journal).append({
      _tag: "McpConnectionStateChanged",
      eventId: `mcp-connection-state:${catalogId}:${crypto.randomUUID()}`,
      catalogId,
      state,
    });
  }
);

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
        yield* AgentStorage.pipe(
          Effect.flatMap(({ database }) =>
            database.transaction(() =>
              changeMcpConnectionState(catalogId, checked)
            )
          )
        );
      }).pipe(Effect.orDie);

export const connectedMessageOf = (
  displayName: string,
  accountLabel: string | undefined
) =>
  accountLabel === undefined
    ? `Connected ${displayName}`
    : `Connected ${displayName} (account ${accountLabel})`;

const announceConnected = Effect.fnUntraced(function* announceConnected(
  displayName: string,
  accountLabel: string | undefined
) {
  const conversation = yield* (yield* OwnerChannelConversation).current;
  if (conversation === undefined) {
    return;
  }
  const channel = yield* Channel;
  yield* channel.send({
    conversationId: conversation.conversationId,
    text: connectedMessageOf(displayName, accountLabel),
  });
});

export const McpConnectedCopySchema = Schema.Struct({
  catalogId: Schema.String,
  tools: McpToolCatalogCopySchema,
  accountLabel: Schema.UndefinedOr(Schema.String),
  completionId: Schema.NonEmptyString,
});

export type McpConnectedCopy = typeof McpConnectedCopySchema.Type;

const completionFailureLog = (
  cause: Cause.Cause<unknown>,
  details: Omit<McpFailure, "phase" | "reason"> = {}
) =>
  mcpFailureLog({
    phase: "completion",
    reason: failureReasonOf(Cause.squash(cause)),
    ...details,
  });

export const receiveMcpConnected = Effect.fnUntraced(
  function* receiveMcpConnected(catalog: McpCatalog, received: unknown) {
    const { catalogId, tools, accountLabel, completionId } =
      yield* Schema.decodeUnknownEffect(McpConnectedCopySchema)(received).pipe(
        Effect.tapCause((cause) => completionFailureLog(cause))
      );
    const entry = mcpEntryOf(catalog, catalogId);
    if (entry === undefined) {
      yield* mcpFailureLog({
        phase: "completion",
        reason: "unknown_catalog_entry",
        catalogId,
      });
      return;
    }
    const drifts = yield* Effect.promise(() =>
      mcpDefinitionDriftsOf(entry, tools)
    );
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;
    const connections = yield* McpConnections;
    const eventId = `mcp-connection-added:${completionId}`;
    const isFirstTime = yield* database
      .transaction(() =>
        Effect.gen(function* recordCompletion() {
          if ((yield* journal.readForEvent(eventId)).length > 0) {
            yield* changeMcpConnectionState(catalogId, "ready");
            return false;
          }
          yield* connections.replaceTools(catalogId, tools);
          yield* recordMcpDefinitionDrifts(drifts);
          yield* changeMcpConnectionState(catalogId, "ready");
          yield* journal.append({
            _tag: "McpConnectionAdded",
            eventId,
            catalogId,
          });
          return true;
        })
      )
      .pipe(
        Effect.tapCause((cause) =>
          completionFailureLog(cause, { catalogId, ...toolCopySizeOf(tools) })
        )
      );
    if (!isFirstTime) {
      return;
    }
    yield* mcpToolCatalogLog(entry, tools);
    yield* announceConnected(entry.displayName, accountLabel).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The Connected message was not sent", cause)
      )
    );
  },
  Effect.orDie
);

export const removeMcpConnection = Effect.fnUntraced(
  function* removeMcpConnection(catalogId: string, revocation: McpRevocation) {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;
    const connections = yield* McpConnections;
    const schedules = yield* Schedules;
    yield* database.transaction(() =>
      Effect.gen(function* recordRemoval() {
        const existed = yield* connections.remove(catalogId);
        yield* makeApprovalsOfConnectionDue(catalogId);
        if (existed) {
          yield* journal.append({
            _tag: "McpConnectionRemoved",
            eventId: `mcp-connection-removed:${crypto.randomUUID()}`,
            catalogId,
            revocation,
          });
        }
        yield* schedules.rearm;
      })
    );
  },
  Effect.orDie
);
