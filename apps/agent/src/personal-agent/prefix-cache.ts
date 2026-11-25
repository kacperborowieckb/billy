import { asSchema } from "ai";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";

import { runToolEffect } from "../model-gateway/agent-tool.ts";
import type { AgentTools, ToolInputGate } from "../model-gateway/agent-tool.ts";
import { sha256Hex } from "../sha256-hex.ts";
import { cacheLifetimeMinutes } from "../tracing/hit-rate-values.ts";
import { AgentStorage } from "./agent-storage.ts";
import { prefixCacheSessions } from "./prefix-cache-schema.ts";
import type {
  HistoryBreak,
  PlannedMiss,
  SessionTask,
} from "./storage-values.ts";

const millisPerMinute = 60_000;

export interface RequestPrefix {
  readonly systemHash: string;
  readonly toolsHash: string;
  readonly ownerContextHash: string;
}

export interface EarlierCall extends RequestPrefix {
  readonly lastCallAtMillis: number;
  readonly historyBreak: HistoryBreak | undefined;
}

const toolNotRun = runToolEffect(Effect.runPromise);

const definitionOnlyGate: ToolInputGate = () => ({
  _tag: "Deny",
  reason: "Only the tool definition is read",
});

const toolDefinitionsText = async (tools: AgentTools) => {
  const definitions = await Promise.all(
    Object.entries(tools).map(async ([name, agentTool]) => {
      const sdkTool = agentTool.toAiSdkTool(toolNotRun, definitionOnlyGate);
      return {
        name,
        description: sdkTool.description,
        inputSchema: await asSchema(sdkTool.inputSchema).jsonSchema,
      };
    })
  );
  return JSON.stringify(definitions);
};

export const requestPrefixOf = Effect.fnUntraced(function* requestPrefixOf(
  system: string,
  tools: AgentTools,
  ownerContext: ModelMessage | undefined
) {
  const definitions = yield* Effect.promise(() => toolDefinitionsText(tools));
  return {
    systemHash: yield* sha256Hex(system),
    toolsHash: yield* sha256Hex(definitions),
    ownerContextHash: yield* sha256Hex(JSON.stringify(ownerContext ?? null)),
  } satisfies RequestPrefix;
});

export const minutesBetween = (earlierMillis: number, laterMillis: number) =>
  (laterMillis - earlierMillis) / millisPerMinute;

export const plannedMissOf = (
  earlier: EarlierCall | undefined,
  prefix: RequestPrefix,
  calledAtMillis: number
): PlannedMiss | undefined => {
  if (earlier === undefined) {
    return "no_earlier_call";
  }
  if (
    minutesBetween(earlier.lastCallAtMillis, calledAtMillis) >
    cacheLifetimeMinutes
  ) {
    return "cache_lifetime";
  }
  if (
    earlier.systemHash !== prefix.systemHash ||
    earlier.toolsHash !== prefix.toolsHash
  ) {
    return "deploy";
  }
  if (earlier.ownerContextHash !== prefix.ownerContextHash) {
    return "owner_context_changed";
  }
  return earlier.historyBreak;
};

export const breakMainConversationPrefix = (
  database: AgentStorage["Service"]["database"],
  historyBreak: HistoryBreak
) =>
  database
    .update(prefixCacheSessions)
    .set({ historyBreak })
    .where(eq(prefixCacheSessions.task, "reply"));

const makePrefixCacheSessions = Effect.gen(
  function* makePrefixCacheSessionsEffect() {
    const { database } = yield* AgentStorage;

    const earlierCallOf = (task: SessionTask) =>
      database
        .select()
        .from(prefixCacheSessions)
        .where(eq(prefixCacheSessions.task, task))
        .pipe(
          Effect.map(([row]) =>
            Option.fromNullishOr(row).pipe(
              Option.map((found): EarlierCall => ({
                lastCallAtMillis: found.lastCallAtMillis,
                systemHash: found.systemHash,
                toolsHash: found.toolsHash,
                ownerContextHash: found.ownerContextHash,
                historyBreak: found.historyBreak ?? undefined,
              })),
              Option.getOrUndefined
            )
          )
        );

    const recordCall = (
      task: SessionTask,
      prefix: RequestPrefix,
      lastCallAtMillis: number
    ) => {
      const call = { ...prefix, lastCallAtMillis, historyBreak: null };
      return database
        .insert(prefixCacheSessions)
        .values({ task, ...call })
        .onConflictDoUpdate({
          target: prefixCacheSessions.task,
          set: call,
        });
    };

    return { earlierCallOf, recordCall };
  }
);

export class PrefixCacheSessions extends Context.Service<
  PrefixCacheSessions,
  Effect.Success<typeof makePrefixCacheSessions>
>()("PrefixCacheSessions") {
  static readonly layer = Layer.effect(
    PrefixCacheSessions,
    makePrefixCacheSessions
  );
}
