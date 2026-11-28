import { Layer } from "effect";

import { PendingApprovals } from "../approval/pending-approvals.ts";
import { Journal } from "../journal/journal.ts";
import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import { McpConnections } from "../mcp/mcp-connections.ts";
import { UsageLedger } from "../model-gateway/usage-ledger.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { AlarmClock } from "../schedule/schedules.ts";
import type { TraceRetention } from "../tracing/trace-retention.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import type { BurstWait } from "./burst-wait.ts";
import { StoredFormLimits } from "./conversation-stubs.ts";
import type { StoredFormLimitValues } from "./conversation-stubs.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";
import { PrefixCacheSessions } from "./prefix-cache.ts";
import { TurnProgress } from "./turn-progress.ts";

export interface AgentSettings {
  readonly clock: AlarmClock;
  readonly burstWait: () => BurstWait;
  readonly traceRetention: () => TraceRetention;
  readonly storedFormLimits: () => StoredFormLimitValues;
  readonly mcpCatalog: () => McpCatalog;
}

export const personalAgentLayer = (
  storage: DurableObjectStorage,
  ownerId: OwnerId,
  {
    clock,
    burstWait,
    traceRetention,
    storedFormLimits,
    mcpCatalog,
  }: AgentSettings
) => {
  const journal = Journal.layer(ownerId);
  const schedules = Schedules.layer(ownerId, clock, {
    burstWait,
    traceRetention,
  }).pipe(Layer.provide(journal));
  return Layer.mergeAll(
    schedules,
    Inbox.layer.pipe(Layer.provide(Layer.merge(journal, TurnProgress.layer))),
    journal,
    Notes.layer(ownerId).pipe(Layer.provide(journal)),
    Profile.layer(ownerId).pipe(Layer.provide(journal)),
    OwnerPreferences.layer.pipe(Layer.provide(journal)),
    ProactiveMessages.layer.pipe(Layer.provide(journal)),
    PendingApprovals.layer.pipe(Layer.provide(journal)),
    Conversation.layer,
    PrefixCacheSessions.layer,
    StoredFormLimits.layer(storedFormLimits),
    OwnerChannelConversation.layer,
    McpConnections.layer(mcpCatalog),
    TurnProgress.layer,
    UsageLedger.layer(ownerId),
    TurnTraces.layer(ownerId)
  ).pipe(Layer.provideMerge(AgentStorage.layer(storage)));
};
