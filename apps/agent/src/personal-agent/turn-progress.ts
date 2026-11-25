import type { JSONValue, ModelMessage } from "ai";
import { asc, count, eq, inArray } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { AgentStorage } from "./agent-storage.ts";
import {
  turnContextBlocks,
  turnModelSteps,
  turnProgress,
  writeBackMarkers,
} from "./turn-progress-schema.ts";
import type { WriteBackMarker } from "./write-back.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

export interface ToolCallProgress {
  readonly eventId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JSONValue;
  readonly redactor: Redactor["Service"];
}

const messagesOfToolCall = (
  { toolCallId, toolName, input }: ToolCallProgress,
  output: JSONValue
): readonly ModelMessage[] => [
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "json", value: output },
      },
    ],
  },
];

const makeTurnProgress = Effect.gen(function* makeTurnProgressEffect() {
  const { database } = yield* AgentStorage;

  const completedFor = (eventId: string) =>
    database
      .select({ message: turnProgress.message })
      .from(turnProgress)
      .where(eq(turnProgress.eventId, eventId))
      .orderBy(asc(turnProgress.sequence))
      .pipe(
        Effect.flatMap((rows) =>
          Effect.all(rows.map((row) => decodeMessage(row.message))).pipe(
            Effect.orDie
          )
        )
      );

  const markModelStep = (eventId: string, modelStepKey: number) =>
    database
      .insert(turnModelSteps)
      .values({ eventId, modelStepKey })
      .onConflictDoNothing();

  const usedStepCount = (eventId: string) =>
    database
      .select({ steps: count() })
      .from(turnModelSteps)
      .where(eq(turnModelSteps.eventId, eventId))
      .pipe(Effect.map(([row]) => row?.steps ?? 0));

  const insertMessages = (eventId: string, messages: readonly ModelMessage[]) =>
    Effect.gen(function* insertMessagesEffect() {
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      for (const message of messages) {
        const checked = yield* checkMessage(message).pipe(Effect.orDie);
        yield* database.insert(turnProgress).values({
          eventId,
          message: encodeMessage(checked),
          recordedAt,
        });
      }
    });

  const record = (call: ToolCallProgress, messages: readonly ModelMessage[]) =>
    insertMessages(
      call.eventId,
      messages.map((message) => call.redactor.redactMessage(message))
    );

  const replaceSteps = (eventId: string, messages: readonly ModelMessage[]) =>
    database
      .transaction(() =>
        database
          .delete(turnProgress)
          .where(eq(turnProgress.eventId, eventId))
          .pipe(Effect.andThen(insertMessages(eventId, messages)))
      )
      .pipe(Effect.andThen(completedFor(eventId)));

  const recordFailedToolCall = (call: ToolCallProgress, message: string) =>
    database.transaction(() =>
      record(call, [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "error-text", value: message },
            },
          ],
        },
      ])
    );

  const recordingToolCall = <Output extends JSONValue, Failure, Needs>(
    call: ToolCallProgress,
    run: Effect.Effect<Output, Failure, Needs>
  ) =>
    database.transaction(() =>
      run.pipe(
        Effect.tap((output) => record(call, messagesOfToolCall(call, output)))
      )
    );

  const recordTurnContext = Effect.fnUntraced(function* recordTurnContext(
    eventId: string,
    text: string
  ) {
    const row = { text, recordedAt: DateTime.formatIso(yield* DateTime.now) };
    yield* database
      .insert(turnContextBlocks)
      .values({ eventId, ...row })
      .onConflictDoUpdate({ target: turnContextBlocks.eventId, set: row });
  });

  const turnContextFor = (eventId: string) =>
    database
      .select({ text: turnContextBlocks.text })
      .from(turnContextBlocks)
      .where(eq(turnContextBlocks.eventId, eventId))
      .pipe(
        Effect.map(([row]) => row?.text),
        Effect.orDie
      );

  const keepWriteBackMarker = Effect.fnUntraced(function* keepWriteBackMarker(
    eventId: string,
    marker: WriteBackMarker
  ) {
    yield* database
      .insert(writeBackMarkers)
      .values({
        eventId,
        kind: marker.kind,
        localTime: marker.localTime,
        recordedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .onConflictDoNothing();
    const [kept] = yield* database
      .select({
        kind: writeBackMarkers.kind,
        localTime: writeBackMarkers.localTime,
      })
      .from(writeBackMarkers)
      .where(eq(writeBackMarkers.eventId, eventId));
    return kept ?? marker;
  });

  const forgetSettled = (eventIds: readonly string[]) =>
    database
      .delete(turnProgress)
      .where(inArray(turnProgress.eventId, [...eventIds]))
      .pipe(
        Effect.andThen(
          database
            .delete(turnContextBlocks)
            .where(inArray(turnContextBlocks.eventId, [...eventIds]))
        ),
        Effect.andThen(
          database
            .delete(writeBackMarkers)
            .where(inArray(writeBackMarkers.eventId, [...eventIds]))
        )
      );

  return {
    completedFor,
    recordTurnContext,
    turnContextFor,
    keepWriteBackMarker,
    forgetSettled,
    markModelStep,
    usedStepCount,
    recordingToolCall,
    recordFailedToolCall,
    replaceSteps,
  };
});

export class TurnProgress extends Context.Service<
  TurnProgress,
  Effect.Success<typeof makeTurnProgress>
>()("TurnProgress") {
  static readonly layer = Layer.effect(TurnProgress, makeTurnProgress);
}
