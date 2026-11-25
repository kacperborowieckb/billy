import { asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { turnTraces } from "../personal-agent/storage-schema.ts";
import {
  proactiveFoldReasons,
  proactiveHoldReasons,
  turnResults,
} from "../personal-agent/storage-values.ts";
import { modelTraceFields } from "./model-trace-fields.ts";
import { storeRequestParts } from "./trace-request-parts.ts";
import type { RequestPart } from "./traced-request.ts";

const ReplyTraceBodySchema = Schema.Struct({
  task: Schema.Literal("reply"),
  ...modelTraceFields,
});

const ScheduledTaskTraceBodySchema = Schema.Struct({
  task: Schema.Literal("scheduled_task"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  ...modelTraceFields,
});

const ProactiveTraceBodySchema = Schema.Struct({
  task: Schema.Literal("proactive"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  dailyTokenBudget: Schema.Number,
  tokensSpentBefore: Schema.Number,
  ...modelTraceFields,
});

const ProactiveHoldTraceBodySchema = Schema.Struct({
  task: Schema.Literal("proactive_hold"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  heldUntil: Schema.String,
  reason: Schema.Literals(proactiveHoldReasons),
});

const ProactiveFoldTraceBodySchema = Schema.Struct({
  task: Schema.Literal("proactive_fold"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  openLoopIds: Schema.Array(Schema.String),
  reason: Schema.Literals(proactiveFoldReasons),
  budget: Schema.optionalKey(Schema.Number),
  used: Schema.optionalKey(Schema.Number),
});

const ScheduledTaskSkipTraceBodySchema = Schema.Struct({
  task: Schema.Literal("scheduled_task_skip"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  dailyTokenBudget: Schema.Number,
  tokensSpent: Schema.Number,
  text: Schema.String,
});

const ReminderDeliveryTraceBodySchema = Schema.Struct({
  task: Schema.Literal("reminder_delivery"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  late: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  text: Schema.String,
  channelMessageId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  latencyMillis: Schema.Number,
});

const TraceBodySchema = Schema.Union([
  ReplyTraceBodySchema,
  ScheduledTaskTraceBodySchema,
  ProactiveTraceBodySchema,
  ProactiveHoldTraceBodySchema,
  ProactiveFoldTraceBodySchema,
  ScheduledTaskSkipTraceBodySchema,
  ReminderDeliveryTraceBodySchema,
]);

const traceFields = {
  eventId: Schema.String,
  result: Schema.Literals(turnResults),
};

export const ReplyTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ReplyTraceBodySchema.fields,
});

export const ScheduledTaskTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ScheduledTaskTraceBodySchema.fields,
});

export const ProactiveTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ProactiveTraceBodySchema.fields,
});

export const ProactiveHoldTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ProactiveHoldTraceBodySchema.fields,
});

export const ProactiveFoldTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ProactiveFoldTraceBodySchema.fields,
});

export const ScheduledTaskSkipTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ScheduledTaskSkipTraceBodySchema.fields,
});

export const ReminderDeliveryTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ReminderDeliveryTraceBodySchema.fields,
});

export const TurnTraceSchema = Schema.Union([
  ReplyTurnTraceSchema,
  ScheduledTaskTurnTraceSchema,
  ProactiveTurnTraceSchema,
  ProactiveHoldTurnTraceSchema,
  ProactiveFoldTurnTraceSchema,
  ScheduledTaskSkipTurnTraceSchema,
  ReminderDeliveryTurnTraceSchema,
]);

export type ReplyTurnTrace = typeof ReplyTurnTraceSchema.Type;

export type ScheduledTaskTurnTrace = typeof ScheduledTaskTurnTraceSchema.Type;

export type ProactiveTurnTrace = typeof ProactiveTurnTraceSchema.Type;

export type ProactiveHoldTurnTrace = typeof ProactiveHoldTurnTraceSchema.Type;

export type ReminderDeliveryTurnTrace =
  typeof ReminderDeliveryTurnTraceSchema.Type;

export type TurnTrace = typeof TurnTraceSchema.Type;

export type ModelTurnTrace =
  | ReplyTurnTrace
  | ScheduledTaskTurnTrace
  | ProactiveTurnTrace;

export type EventTurnTrace = Exclude<TurnTrace, ModelTurnTrace>;

export interface StoredTurnTrace<Trace extends TurnTrace = TurnTrace> {
  readonly sequence: number;
  readonly ownerId: OwnerId;
  readonly recordedAt: string;
  readonly trace: Trace;
}

export type StoredReplyTurnTrace = StoredTurnTrace<ReplyTurnTrace>;

const BodyJsonSchema = Schema.fromJsonString(TraceBodySchema);

const encodeBody = Schema.encodeSync(BodyJsonSchema);
const decodeBody = Schema.decodeUnknownSync(BodyJsonSchema);

const toStoredTrace = (
  row: typeof turnTraces.$inferSelect
): StoredTurnTrace => ({
  sequence: row.sequence,
  ownerId: OwnerIdSchema.make(row.ownerId),
  recordedAt: row.recordedAt,
  trace: {
    eventId: row.eventId,
    result: row.result,
    ...decodeBody(row.record),
  },
});

export interface ModelTurnRecord {
  readonly trace: ModelTurnTrace;
  readonly requestParts: readonly RequestPart[];
}

const makeTurnTraces = (ownerId: OwnerId) =>
  Effect.gen(function* makeTurnTracesEffect() {
    const { database } = yield* AgentStorage;

    const insertTrace = Effect.fnUntraced(function* insertTrace({
      eventId,
      result,
      ...body
    }: TurnTrace) {
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const [inserted] = yield* database
        .insert(turnTraces)
        .values({
          ownerId,
          recordedAt,
          eventId,
          result,
          record: encodeBody(body),
        })
        .returning({ sequence: turnTraces.sequence });
      return { sequence: inserted?.sequence, recordedAt };
    });

    const record = (trace: EventTurnTrace) =>
      insertTrace(trace).pipe(Effect.asVoid);

    const recordModelTurn = ({ trace, requestParts }: ModelTurnRecord) =>
      database.transaction(() =>
        insertTrace(trace).pipe(
          Effect.flatMap(({ sequence, recordedAt }) =>
            sequence === undefined
              ? Effect.die("The Trace insert returned no sequence")
              : storeRequestParts(database, {
                  parts: requestParts,
                  traceSequence: sequence,
                  usedAt: recordedAt,
                })
          )
        )
      );

    const read = database
      .select()
      .from(turnTraces)
      .orderBy(asc(turnTraces.sequence))
      .pipe(Effect.map((rows) => rows.map(toStoredTrace)));

    const readForEvent = (eventId: string) =>
      database
        .select()
        .from(turnTraces)
        .where(eq(turnTraces.eventId, eventId))
        .orderBy(asc(turnTraces.sequence))
        .pipe(Effect.map((rows) => rows.map(toStoredTrace)));

    const readReplies = read.pipe(
      Effect.map((stored) =>
        stored.flatMap(({ trace, ...rest }) =>
          trace.task === "reply" ? [{ ...rest, trace }] : []
        )
      )
    );

    return { record, recordModelTurn, read, readForEvent, readReplies };
  });

export class TurnTraces extends Context.Service<
  TurnTraces,
  Effect.Success<ReturnType<typeof makeTurnTraces>>
>()("TurnTraces") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(TurnTraces, makeTurnTraces(ownerId));
}
