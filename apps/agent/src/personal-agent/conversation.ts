import type { ModelMessage } from "ai";
import { asc } from "drizzle-orm";
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

export interface ConversationEntry {
  readonly eventId: string;
  readonly rows: readonly ConversationRow[];
  readonly recordedAs?: string | undefined;
}

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

  const writeRows = (eventId: string, rows: readonly ConversationRow[]) =>
    Effect.gen(function* writeRowsEffect() {
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

  return { history, append };
});

export class Conversation extends Context.Service<
  Conversation,
  Effect.Success<typeof makeConversation>
>()("Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation);
}
