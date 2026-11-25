import { and, asc, eq, gt, gte, isNotNull, max, sum } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { modelUsage } from "../personal-agent/storage-schema.ts";
import { modelTasks } from "../personal-agent/storage-values.ts";
import type { ModelTask } from "./model-provider.ts";

export interface Usage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly costUsd: number | undefined;
}

const sumDefined = (values: readonly (number | undefined)[]) => {
  const defined = values.filter((value) => value !== undefined);
  return defined.length === 0
    ? undefined
    : defined.reduce((total, value) => total + value, 0);
};

export const sumUsage = (usages: readonly Usage[]): Usage => ({
  inputTokens: sumDefined(usages.map((usage) => usage.inputTokens)),
  outputTokens: sumDefined(usages.map((usage) => usage.outputTokens)),
  cachedInputTokens: sumDefined(usages.map((usage) => usage.cachedInputTokens)),
  costUsd: sumDefined(usages.map((usage) => usage.costUsd)),
});

export const UsageRecordSchema = Schema.Struct({
  ownerId: OwnerIdSchema,
  task: Schema.Literals(modelTasks),
  modelId: Schema.String,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

export type UsageRecord = typeof UsageRecordSchema.Type;

export interface UsageSource {
  readonly task: ModelTask;
  readonly eventId?: string | undefined;
}

export interface ReportedStep {
  readonly eventId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

const toUsageRecord = (row: typeof modelUsage.$inferSelect): UsageRecord => ({
  ownerId: row.ownerId,
  task: row.task,
  modelId: row.modelId,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedInputTokens: row.cachedInputTokens,
  costUsd: row.costUsd,
});

const makeUsageLedger = (ownerId: OwnerId) =>
  Effect.gen(function* makeUsageLedgerEffect() {
    const { database } = yield* AgentStorage;

    const record = Effect.fnUntraced(function* record(
      { task, eventId }: UsageSource,
      modelId: string,
      usage: Usage
    ) {
      yield* database.insert(modelUsage).values({
        ownerId,
        recordedAt: DateTime.formatIso(yield* DateTime.now),
        task,
        eventId: eventId ?? null,
        modelId,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        costUsd: usage.costUsd ?? null,
      });
    });

    const tokensSpent = (task: ModelTask, since: DateTime.Utc) =>
      database
        .select({
          input: sum(modelUsage.inputTokens),
          output: sum(modelUsage.outputTokens),
        })
        .from(modelUsage)
        .where(
          and(
            eq(modelUsage.ownerId, ownerId),
            eq(modelUsage.task, task),
            gte(modelUsage.recordedAt, DateTime.formatIso(since))
          )
        )
        .pipe(
          Effect.map(
            ([row]) => Number(row?.input ?? 0) + Number(row?.output ?? 0)
          )
        );

    const lastSequenceOf = (eventId: string) =>
      database
        .select({ last: max(modelUsage.sequence) })
        .from(modelUsage)
        .where(eq(modelUsage.eventId, eventId))
        .pipe(Effect.map(([row]) => row?.last ?? 0));

    const stepsAfterEvent = Effect.fnUntraced(function* stepsAfterEvent(
      task: ModelTask,
      afterEventId: string | undefined
    ) {
      const after =
        afterEventId === undefined ? 0 : yield* lastSequenceOf(afterEventId);
      const rows = yield* database
        .select({
          eventId: modelUsage.eventId,
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
        })
        .from(modelUsage)
        .where(
          and(
            eq(modelUsage.task, task),
            isNotNull(modelUsage.eventId),
            gt(modelUsage.sequence, after)
          )
        )
        .orderBy(asc(modelUsage.sequence));
      return rows.flatMap(({ eventId, ...tokens }): ReportedStep[] =>
        eventId === null ? [] : [{ eventId, ...tokens }]
      );
    });

    const read = database
      .select()
      .from(modelUsage)
      .orderBy(asc(modelUsage.sequence))
      .pipe(Effect.map((rows) => rows.map(toUsageRecord)));

    return { record, read, tokensSpent, stepsAfterEvent };
  });

export class UsageLedger extends Context.Service<
  UsageLedger,
  Effect.Success<ReturnType<typeof makeUsageLedger>>
>()("UsageLedger") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(UsageLedger, makeUsageLedger(ownerId));
}
