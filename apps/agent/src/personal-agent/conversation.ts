import type { ModelMessage } from "ai";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import { AgentStorage } from "./agent-storage.ts";
import {
  conversationMessages,
  conversationRecordedEvents,
} from "./storage-schema.ts";
import type { ConversationRowKind } from "./storage-values.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

export interface ConversationRow {
  readonly kind: ConversationRowKind;
  readonly message: ModelMessage;
}

export interface StoredConversationRow extends ConversationRow {
  readonly sequence: number;
  readonly eventId: string;
}

export interface NewSummary {
  readonly compactionId: string;
  readonly lastCompactedSequence: number;
  readonly message: ModelMessage;
}

const summaryFirst = <Row extends { readonly kind: ConversationRowKind }>(
  rows: readonly Row[]
) => [
  ...rows.filter((row) => row.kind === "summary"),
  ...rows.filter((row) => row.kind !== "summary"),
];

const chatTextRowKinds: readonly ConversationRowKind[] = [
  "input",
  "reply",
  "write_back",
  "write_back_stub",
];

export interface ConversationEntry {
  readonly eventId: string;
  readonly rows: readonly ConversationRow[];
  readonly recordedAs?: string | undefined;
}

const decodedRows = (
  rows: readonly {
    readonly kind: ConversationRowKind;
    readonly message: string;
  }[]
) =>
  Effect.all(
    rows.map(({ kind, message }) =>
      decodeMessage(message).pipe(
        Effect.map((decoded): ConversationRow => ({ kind, message: decoded }))
      )
    )
  ).pipe(Effect.orDie);

const makeConversation = Effect.gen(function* makeConversationEffect() {
  const { database } = yield* AgentStorage;

  const uncompactedRows = database
    .select()
    .from(conversationMessages)
    .where(isNull(conversationMessages.compactedAt))
    .orderBy(asc(conversationMessages.sequence))
    .pipe(
      Effect.flatMap((rows) =>
        Effect.all(
          summaryFirst(rows).map((row) =>
            decodeMessage(row.message).pipe(
              Effect.map((message): StoredConversationRow => ({
                sequence: row.sequence,
                eventId: row.eventId,
                kind: row.kind,
                message,
              }))
            )
          )
        ).pipe(Effect.orDie)
      )
    );

  const summaryEventId = database
    .select({ eventId: conversationMessages.eventId })
    .from(conversationMessages)
    .where(
      and(
        isNull(conversationMessages.compactedAt),
        eq(conversationMessages.kind, "summary")
      )
    )
    .pipe(Effect.map(([row]) => row?.eventId));

  const history = uncompactedRows.pipe(
    Effect.map((rows) => rows.map((row) => row.message)),
    Effect.orDie
  );

  const writeRows = Effect.fnUntraced(function* writeRows(
    eventId: string,
    rows: readonly ConversationRow[]
  ) {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    for (const { kind, message } of rows) {
      const checked = yield* checkMessage(message).pipe(Effect.orDie);
      yield* database.insert(conversationMessages).values({
        eventId,
        kind,
        message: encodeMessage(checked),
        recordedAt,
      });
    }
  });

  const append = ({ eventId, rows, recordedAs }: ConversationEntry) =>
    database.transaction(() =>
      Effect.gen(function* appendEffect() {
        const [recorded] = yield* database
          .insert(conversationRecordedEvents)
          .values({ eventId: recordedAs ?? eventId })
          .onConflictDoNothing()
          .returning();
        if (recorded !== undefined) {
          yield* writeRows(eventId, rows);
        }
      })
    );

  const replaceWithSummary = ({
    compactionId,
    lastCompactedSequence,
    message,
  }: NewSummary) =>
    database.transaction(() =>
      Effect.gen(function* replaceWithSummaryEffect() {
        const compactedAt = DateTime.formatIso(yield* DateTime.now);
        yield* database
          .update(conversationMessages)
          .set({ compactedAt })
          .where(
            and(
              isNull(conversationMessages.compactedAt),
              lte(conversationMessages.sequence, lastCompactedSequence)
            )
          );
        yield* database
          .update(conversationMessages)
          .set({ compactedAt })
          .where(
            and(
              isNull(conversationMessages.compactedAt),
              eq(conversationMessages.kind, "summary")
            )
          );
        yield* writeRows(compactionId, [{ kind: "summary", message }]);
      })
    );

  const recentTextRows = Effect.fnUntraced(function* recentTextRows(
    count: number
  ) {
    const rows = yield* database
      .select({
        kind: conversationMessages.kind,
        message: conversationMessages.message,
      })
      .from(conversationMessages)
      .where(
        and(
          isNull(conversationMessages.compactedAt),
          inArray(conversationMessages.kind, chatTextRowKinds)
        )
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(count)
      .pipe(Effect.orDie);
    return (yield* decodedRows(rows)).toReversed();
  });

  const sentTextIsStoredInFull = Effect.fnUntraced(
    function* sentTextIsStoredInFull(eventId: string) {
      const rows = yield* database
        .select({
          kind: conversationMessages.kind,
          message: conversationMessages.message,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.eventId, eventId),
            inArray(conversationMessages.kind, [
              "write_back",
              "write_back_stub",
            ])
          )
        )
        .pipe(Effect.orDie);
      return rows.length > 0 && rows.every(({ kind }) => kind === "write_back");
    }
  );

  return {
    history,
    uncompactedRows,
    summaryEventId,
    replaceWithSummary,
    append,
    recentTextRows,
    sentTextIsStoredInFull,
  };
});

export class Conversation extends Context.Service<
  Conversation,
  Effect.Success<typeof makeConversation>
>()("Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation);
}
