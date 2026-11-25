import { and, between, eq, ne, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { ModelMessageJsonSchema } from "../model-gateway/model-message-schema.ts";
import type { SentConversationRows } from "../tracing/traced-request.ts";
import type { StoredConversationRow } from "./conversation.ts";
import { conversationMessages } from "./storage-schema.ts";
import type { ConversationRowKind } from "./storage-values.ts";

const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);

export const summaryFirst = <
  Row extends { readonly kind: ConversationRowKind },
>(
  rows: readonly Row[]
) => [
  ...rows.filter((row) => row.kind === "summary"),
  ...rows.filter((row) => row.kind !== "summary"),
];

export const storedRowsOf = (
  rows: readonly (typeof conversationMessages.$inferSelect)[]
) =>
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
  ).pipe(Effect.orDie);

export const sentRowsCondition = ({
  summarySequence,
  firstSequence,
  lastSequence,
}: SentConversationRows): SQL | undefined =>
  or(
    summarySequence === null
      ? undefined
      : eq(conversationMessages.sequence, summarySequence),
    firstSequence === null || lastSequence === null
      ? undefined
      : and(
          ne(conversationMessages.kind, "summary"),
          between(conversationMessages.sequence, firstSequence, lastSequence)
        )
  );
