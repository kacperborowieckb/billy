import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import { McpConnections } from "../mcp/mcp-connections.ts";
import { McpHubPort } from "../mcp/mcp-hub-contract.ts";
import type { McpToolCopy } from "../mcp/mcp-tool-copy.ts";
import { Notes } from "../notes/notes.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnProgress } from "./turn-progress.ts";

const mcpSnapshot = Effect.gen(function* mcpSnapshotEffect() {
  const connections = yield* McpConnections;
  const states = new Map(
    (yield* connections.states).map(({ catalogId, state }) => [
      catalogId,
      state,
    ])
  );
  const copies = new Map<string, readonly McpToolCopy[]>();
  for (const catalogId of states.keys()) {
    copies.set(catalogId, yield* connections.tools(catalogId));
  }
  return {
    catalog: connections.catalog,
    states,
    copies,
    hub: yield* McpHubPort,
  };
});

export const agentToolServices = Effect.gen(
  function* agentToolServicesEffect() {
    return {
      mcp: yield* mcpSnapshot,
      journal: yield* Journal,
      notes: yield* Notes,
      profile: yield* Profile,
      proactiveMessages: yield* ProactiveMessages,
      preferences: yield* OwnerPreferences,
      schedules: yield* Schedules,
      progress: yield* TurnProgress,
      redactor: yield* Redactor,
    };
  }
);
