import type { ModelMessage } from "ai";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import { trustLevelOfParts } from "../notes/note.ts";
import type { TrustLevel } from "../notes/note.ts";
import type { SentConversationRows } from "../tracing/traced-request.ts";
import { AgentStorage } from "./agent-storage.ts";
import {
  decodedRows,
  sentRowsCondition,
  storedRowsOf,
  summaryFirst,
} from "./conversation-rows.ts";
import {
  conversationMessages,
  conversationRecordedEvents,
  refusedCompactionBlocks,
} from "./conversation-schema.ts";
import { breakMainConversationPrefix } from "./prefix-cache.ts";
import type { ConversationRowKind } from "./storage-values.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

export interface ConversationRow {
  readonly kind: ConversationRowKind;
  readonly message: ModelMessage;
  readonly trustLevel: TrustLevel;
}

export interface StoredConversationRow extends ConversationRow {
  readonly sequence: number;
  readonly eventId: string;
}

export interface NewSummary {
  readonly compactionId: string;
  readonly lastCompactedSequence: number;
  readonly message: ModelMessage;
  readonly trustLevel: TrustLevel;
}

const chatTextRowKinds: readonly ConversationRowKind[] = [
  "input",
  "reply",
  "write_back",
];

export interface ConversationEntry {
  readonly eventId: string;
  readonly rows: readonly ConversationRow[];
  readonly recordedAs?: string | undefined;
  readonly storedWithStub?: boolean;
}

const makeConversation = Effect.gen(function* makeConversationEffect() {
  const { database } = yield* AgentStorage;

  const storedRowsWhere = (where: SQL) =>
    database
      .select()
      .from(conversationMessages)
      .where(where)
      .orderBy(asc(conversationMessages.sequence))
      .pipe(Effect.flatMap(storedRowsOf));

  const uncompactedRows = storedRowsWhere(
    isNull(conversationMessages.compactedAt)
  );

  const sentRows = (sent: SentConversationRows) => {
    const condition = sentRowsCondition(sent);
    return condition === undefined
      ? Effect.succeed([])
      : database
          .select({
            kind: conversationMessages.kind,
            message: conversationMessages.message,
          })
          .from(conversationMessages)
          .where(condition)
          .orderBy(asc(conversationMessages.sequence))
          .pipe(Effect.map(summaryFirst));
  };

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

  const uncompactedTrustLevel = database
    .selectDistinct({ trustLevel: conversationMessages.trustLevel })
    .from(conversationMessages)
    .where(isNull(conversationMessages.compactedAt))
    .pipe(Effect.map(trustLevelOfParts), Effect.orDie);

  const history = uncompactedRows.pipe(
    Effect.map((rows) => rows.map((row) => row.message)),
    Effect.orDie
  );

  const writeRows = Effect.fnUntraced(function* writeRows(
    eventId: string,
    rows: readonly ConversationRow[]
  ) {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    for (const { message, ...row } of rows) {
      const checked = yield* checkMessage(message).pipe(Effect.orDie);
      yield* database.insert(conversationMessages).values({
        ...row,
        eventId,
        message: encodeMessage(checked),
        recordedAt,
      });
    }
  });

  const append = ({
    eventId,
    rows,
    recordedAs,
    storedWithStub = false,
  }: ConversationEntry) =>
    database.transaction(() =>
      Effect.gen(function* appendEffect() {
        const [recorded] = yield* database
          .insert(conversationRecordedEvents)
          .values({ eventId: recordedAs ?? eventId })
          .onConflictDoNothing()
          .returning();
        if (recorded !== undefined) {
          yield* writeRows(eventId, rows);
          if (storedWithStub) {
            yield* breakMainConversationPrefix(database, "stub_in_turn_before");
          }
        }
      })
    );

  const replaceWithSummary = ({
    compactionId,
    lastCompactedSequence,
    message,
    trustLevel,
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
        yield* writeRows(compactionId, [
          { kind: "summary", message, trustLevel },
        ]);
        yield* breakMainConversationPrefix(database, "compaction");
      })
    );

  const lastRefusedBlockEnd = database
    .select({ sequence: refusedCompactionBlocks.lastCompactedSequence })
    .from(refusedCompactionBlocks)
    .pipe(Effect.map(([row]) => Option.fromNullishOr(row?.sequence)));

  const recordRefusedBlock = Effect.fnUntraced(function* recordRefusedBlock(
    lastCompactedSequence: number
  ) {
    const refusedAt = DateTime.formatIso(yield* DateTime.now);
    yield* database
      .insert(refusedCompactionBlocks)
      .values({ slot: 0, lastCompactedSequence, refusedAt })
      .onConflictDoUpdate({
        target: refusedCompactionBlocks.slot,
        set: {
          lastCompactedSequence: sql`max(${refusedCompactionBlocks.lastCompactedSequence}, excluded.last_compacted_sequence)`,
          refusedAt,
        },
      });
  });

  const recentTextRows = Effect.fnUntraced(function* recentTextRows(
    count: number
  ) {
    const rows = yield* database
      .select({
        kind: conversationMessages.kind,
        message: conversationMessages.message,
        trustLevel: conversationMessages.trustLevel,
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

  const sentTextIsTrusted = Effect.fnUntraced(function* sentTextIsTrusted(
    eventId: string
  ) {
    const rows = yield* database
      .select({ trustLevel: conversationMessages.trustLevel })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.eventId, eventId),
          eq(conversationMessages.kind, "write_back")
        )
      )
      .pipe(Effect.orDie);
    return rows.length > 0 && trustLevelOfParts(rows) === "owner";
  });

  return {
    history,
    uncompactedTrustLevel,
    uncompactedRows,
    sentRows,
    summaryEventId,
    replaceWithSummary,
    lastRefusedBlockEnd,
    recordRefusedBlock,
    append,
    recentTextRows,
    sentTextIsTrusted,
  };
});

export class Conversation extends Context.Service<
  Conversation,
  Effect.Success<typeof makeConversation>
>()("Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation);
}
