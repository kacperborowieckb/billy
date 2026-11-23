import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { journalEntries } from "../personal-agent/storage-schema.ts";
import { JournalRecordSchema } from "./journal-record.ts";
import type { JournalRecord } from "./journal-record.ts";

export { JournalRecordSchema, RestartRecordSchema } from "./journal-record.ts";
export type { JournalRecord } from "./journal-record.ts";

export interface JournalEntry {
  readonly sequence: number;
  readonly ownerId: OwnerId;
  readonly recordedAt: string;
  readonly record: JournalRecord;
}

export const answeringTurnEventIdOf = (entries: readonly JournalEntry[]) => {
  const link = entries.find((entry) => entry.record._tag === "AnsweredByTurn");
  return link?.record._tag === "AnsweredByTurn"
    ? link.record.turnEventId
    : undefined;
};

export const isRestartRecord = (record: JournalRecord) =>
  record._tag === "EventReceived" && record.restart !== undefined;

export const restartCountOf = (entries: readonly JournalEntry[]) =>
  entries.filter((entry) => isRestartRecord(entry.record)).length;

const RecordJsonSchema = Schema.fromJsonString(JournalRecordSchema);

const decodeRecord = Schema.decodeUnknownSync(RecordJsonSchema);

const toJournalEntry = (
  row: typeof journalEntries.$inferSelect
): JournalEntry => ({
  sequence: row.sequence,
  ownerId: row.ownerId,
  recordedAt: row.recordedAt,
  record: decodeRecord(row.record),
});

const makeJournal = (ownerId: OwnerId) =>
  Effect.gen(function* makeJournalEffect() {
    const { database } = yield* AgentStorage;

    const append = (record: JournalRecord) =>
      database
        .insert(journalEntries)
        .values({
          ownerId,
          recordedAt: new Date().toISOString(),
          kind: record._tag,
          eventId: record.eventId,
          record: Schema.encodeSync(RecordJsonSchema)(record),
        })
        .pipe(Effect.asVoid);

    const read = database
      .select()
      .from(journalEntries)
      .orderBy(asc(journalEntries.sequence))
      .pipe(Effect.map((rows) => rows.map(toJournalEntry)));

    const readForEvent = (eventId: string) =>
      database
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.eventId, eventId))
        .orderBy(asc(journalEntries.sequence))
        .pipe(Effect.map((rows) => rows.map(toJournalEntry)));

    const hasEntryOfKind = (kind: JournalRecord["_tag"]) =>
      database
        .select({ sequence: journalEntries.sequence })
        .from(journalEntries)
        .where(eq(journalEntries.kind, kind))
        .limit(1)
        .pipe(Effect.map((rows) => rows.length > 0));

    const readOfKind = (kind: JournalRecord["_tag"]) =>
      database
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.kind, kind))
        .orderBy(asc(journalEntries.sequence))
        .pipe(Effect.map((rows) => rows.map(toJournalEntry)));

    const eventIdsAnsweredByTurn = (turnEventId: string) =>
      readOfKind("AnsweredByTurn").pipe(
        Effect.map((entries) =>
          entries.flatMap(({ record }) =>
            record._tag === "AnsweredByTurn" &&
            record.turnEventId === turnEventId
              ? [record.eventId]
              : []
          )
        )
      );

    return {
      append,
      read,
      readForEvent,
      hasEntryOfKind,
      readOfKind,
      eventIdsAnsweredByTurn,
    };
  });

export class Journal extends Context.Service<
  Journal,
  Effect.Success<ReturnType<typeof makeJournal>>
>()("Journal") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Journal, makeJournal(ownerId));
}
