import { and, isNotNull, lte, min, sql } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import { AgentStorage } from "../personal-agent/agent-storage.ts";
import {
  conversationMessages,
  turnTraces,
} from "../personal-agent/storage-schema.ts";
import { earlierOf } from "../schedule/outcome-alarm-queries.ts";
import type { TraceRetentionDays } from "./trace-retention-days.ts";
import {
  traceRequestParts,
  traceRetentionRuns,
} from "./trace-storage-schema.ts";

export type TraceRetentionRun = "Ran" | "NotDue";

const retentionRunInterval = { days: 1 } as const;

const instantOf = (iso: string | null | undefined) =>
  Option.fromNullishOr(iso).pipe(Option.flatMap(DateTime.make));

type Database = AgentStorage["Service"]["database"];

const lastRunAt = Effect.fnUntraced(function* lastRunAt(database: Database) {
  const [run] = yield* database
    .select({ ranAt: traceRetentionRuns.ranAt })
    .from(traceRetentionRuns);
  return instantOf(run?.ranAt);
});

const nextRunNotBefore = (lastRun: Option.Option<DateTime.Utc>) =>
  lastRun.pipe(
    Option.map((ranAt) => DateTime.add(ranAt, retentionRunInterval))
  );

const isNotTheCurrentVersion = sql`trace_request_parts.last_used_at < (
  SELECT max(newer.last_used_at) FROM trace_request_parts AS newer
  WHERE newer.kind = trace_request_parts.kind AND newer.task = trace_request_parts.task
)`;

const noTracePointsToTheVersion = sql`NOT EXISTS (
  SELECT 1 FROM turn_traces
  WHERE json_extract(turn_traces.record, '$.task') = trace_request_parts.task
  AND json_extract(turn_traces.record, CASE trace_request_parts.kind
    WHEN 'system' THEN '$.request.systemHash'
    WHEN 'tool_definitions' THEN '$.request.toolDefinitionsHash'
    WHEN 'owner_context' THEN '$.request.ownerContextHash'
  END) = trace_request_parts.hash
)`;

const deleteExpired = Effect.fnUntraced(function* deleteExpired(
  database: Database,
  now: DateTime.Utc,
  retentionDays: TraceRetentionDays
) {
  const cutoff = DateTime.formatIso(
    DateTime.subtract(now, { days: retentionDays })
  );
  yield* database.delete(turnTraces).where(lte(turnTraces.recordedAt, cutoff));
  yield* database
    .delete(conversationMessages)
    .where(
      and(
        isNotNull(conversationMessages.compactedAt),
        lte(conversationMessages.compactedAt, cutoff)
      )
    );
  yield* database
    .delete(traceRequestParts)
    .where(and(isNotTheCurrentVersion, noTracePointsToTheVersion));
  yield* database
    .insert(traceRetentionRuns)
    .values({ slot: 0, ranAt: DateTime.formatIso(now) })
    .onConflictDoUpdate({
      target: traceRetentionRuns.slot,
      set: { ranAt: DateTime.formatIso(now) },
    });
});

export const runTraceRetentionWhenDue = Effect.fnUntraced(
  function* runTraceRetentionWhenDue(retentionDays: TraceRetentionDays) {
    const { database } = yield* AgentStorage;
    const now = yield* DateTime.now;
    const notBefore = nextRunNotBefore(yield* lastRunAt(database));
    if (Option.isSome(notBefore) && DateTime.isLessThan(now, notBefore.value)) {
      return "NotDue" satisfies TraceRetentionRun;
    }
    yield* database.transaction(() =>
      deleteExpired(database, now, retentionDays)
    );
    return "Ran" satisfies TraceRetentionRun;
  }
);

const oldestExpiringAt = Effect.fnUntraced(function* oldestExpiringAt(
  database: Database
) {
  const [trace] = yield* database
    .select({ recordedAt: min(turnTraces.recordedAt) })
    .from(turnTraces);
  const [row] = yield* database
    .select({ compactedAt: min(conversationMessages.compactedAt) })
    .from(conversationMessages);
  return earlierOf(instantOf(trace?.recordedAt), instantOf(row?.compactedAt));
});

export const traceRetentionAlarmAt = Effect.fnUntraced(
  function* traceRetentionAlarmAt(
    database: Database,
    retentionDays: TraceRetentionDays
  ) {
    const oldest = yield* oldestExpiringAt(database);
    const notBefore = nextRunNotBefore(yield* lastRunAt(database));
    return oldest.pipe(
      Option.map((instant) => {
        const expiresAt = DateTime.add(instant, { days: retentionDays });
        return Option.isSome(notBefore)
          ? DateTime.max(expiresAt, notBefore.value)
          : expiresAt;
      })
    );
  }
);
