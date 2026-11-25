import { and, eq, isNotNull, lt, lte, max, min, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
  traceRequestPartUses,
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

const newerVersion = alias(traceRequestParts, "newer_version");

const isNotTheCurrentVersion = (database: Database) =>
  lt(
    traceRequestParts.lastUsedAt,
    database
      .select({ lastUsedAt: max(newerVersion.lastUsedAt) })
      .from(newerVersion)
      .where(
        and(
          eq(newerVersion.kind, traceRequestParts.kind),
          eq(newerVersion.task, traceRequestParts.task)
        )
      )
  );

const noTraceUsesTheVersion = (database: Database) =>
  notExists(
    database
      .select({ traceSequence: traceRequestPartUses.traceSequence })
      .from(traceRequestPartUses)
      .where(
        and(
          eq(traceRequestPartUses.kind, traceRequestParts.kind),
          eq(traceRequestPartUses.task, traceRequestParts.task),
          eq(traceRequestPartUses.hash, traceRequestParts.hash)
        )
      )
  );

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
    .where(
      and(isNotTheCurrentVersion(database), noTraceUsesTheVersion(database))
    );
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
