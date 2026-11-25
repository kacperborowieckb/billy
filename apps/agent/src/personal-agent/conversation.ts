import type { ModelMessage } from "ai";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
import { writeBackHoldsSentText } from "./write-back.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

export interface ConversationRow {
  readonly kind: ConversationRowKind;
  readonly message: ModelMessage;
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

  const history = database
    .select({ message: conversationMessages.message })
    .from(conversationMessages)
    .orderBy(asc(conversationMessages.sequence))
    .pipe(
      Effect.flatMap((rows) =>
        Effect.all(rows.map((row) => decodeMessage(row.message)))
      ),
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

  const recentTextRows = Effect.fnUntraced(function* recentTextRows(
    count: number
  ) {
    const rows = yield* database
      .select({
        kind: conversationMessages.kind,
        message: conversationMessages.message,
      })
      .from(conversationMessages)
      .where(inArray(conversationMessages.kind, chatTextRowKinds))
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
            eq(conversationMessages.kind, "write_back")
          )
        )
        .pipe(Effect.orDie);
      const writeBacks = yield* decodedRows(rows);
      return (
        writeBacks.length > 0 &&
        writeBacks.every(({ message }) => writeBackHoldsSentText(message))
      );
    }
  );

  return { history, append, recentTextRows, sentTextIsStoredInFull };
});

export class Conversation extends Context.Service<
  Conversation,
  Effect.Success<typeof makeConversation>
>()("Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation);
}
