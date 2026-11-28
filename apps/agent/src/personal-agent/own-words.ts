import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { AgentStorage } from "./agent-storage.ts";
import { inboxEvents } from "./storage-schema.ts";

type Database = AgentStorage["Service"]["database"];

const OwnWordsSchema = Schema.Struct({
  text: Schema.String,
  sentAt: Schema.String,
});

export type OwnWords = typeof OwnWordsSchema.Type;

const decodeOwnWords = Schema.decodeUnknownSync(OwnWordsSchema);

export const ownWordsQueryOf =
  (database: Database) => (eventId: string, count: number) =>
    database
      .select({ text: inboxEvents.text, sentAt: inboxEvents.sentAt })
      .from(inboxEvents)
      .where(
        and(
          eq(inboxEvents.kind, "OwnerMessage"),
          isNull(inboxEvents.forwardOrigin),
          lt(
            inboxEvents.sequence,
            database
              .select({ sequence: inboxEvents.sequence })
              .from(inboxEvents)
              .where(eq(inboxEvents.eventId, eventId))
          )
        )
      )
      .orderBy(desc(inboxEvents.sequence))
      .limit(count)
      .pipe(
        Effect.map((rows) =>
          rows.toReversed().map((row) => decodeOwnWords(row))
        )
      );
