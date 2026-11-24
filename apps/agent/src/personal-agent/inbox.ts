import { and, asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import {
  approvalAnsweredFields,
  ownerMessageFields,
  scheduleFiredFields,
} from "../event.ts";
import type {
  ApprovalAnswered,
  Event,
  OwnerMessage,
  ScheduleFired,
} from "../event.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "./agent-storage.ts";
import { makeBurstWaitQueries } from "./burst-wait.ts";
import { inboxEvents } from "./storage-schema.ts";
import { inboxStates } from "./storage-values.ts";
import { TurnProgress } from "./turn-progress.ts";

const inboxFields = {
  eventId: Schema.String,
  receivedAt: Schema.String,
  state: Schema.Literals(inboxStates),
};

export const InboxEventSchema = Schema.TaggedUnion({
  OwnerMessage: {
    ...ownerMessageFields,
    ...inboxFields,
  },
  ScheduleFired: {
    ...scheduleFiredFields,
    ...inboxFields,
  },
  ApprovalAnswered: {
    ...approvalAnsweredFields,
    ...inboxFields,
  },
});

export type InboxEvent = typeof InboxEventSchema.Type;

export type OwnerMessageEvent = Extract<InboxEvent, { _tag: "OwnerMessage" }>;

export type ScheduleFiredEvent = Extract<InboxEvent, { _tag: "ScheduleFired" }>;

export type ApprovalAnsweredEvent = Extract<
  InboxEvent,
  { _tag: "ApprovalAnswered" }
>;

export type StoreResult = "stored" | "duplicate";

const decodeInboxEvent = Schema.decodeUnknownSync(InboxEventSchema);

const withoutNulls = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const toInboxEvent = (row: typeof inboxEvents.$inferSelect): InboxEvent =>
  decodeInboxEvent({
    ...withoutNulls(row),
    _tag: row.kind,
  });

const hasOwnerPriority = (event: InboxEvent) =>
  event._tag === "OwnerMessage" || event._tag === "ApprovalAnswered";

const ownerEventsFirst = (events: readonly InboxEvent[]) => [
  ...events.filter(hasOwnerPriority),
  ...events.filter((event) => !hasOwnerPriority(event)),
];

const newPendingRow = Effect.fnUntraced(function* newPendingRow() {
  return {
    eventId: crypto.randomUUID(),
    receivedAt: DateTime.formatIso(yield* DateTime.now),
    state: "pending",
  } as const;
});

const makeInbox = Effect.gen(function* makeInboxEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const progress = yield* TurnProgress;

  const insertOwnerMessage = Effect.fnUntraced(function* insertOwnerMessage({
    _tag,
    ...message
  }: OwnerMessage) {
    return yield* database
      .insert(inboxEvents)
      .values({ ...(yield* newPendingRow()), kind: _tag, ...message })
      .onConflictDoNothing({
        target: [inboxEvents.channel, inboxEvents.channelUpdateId],
      })
      .returning({ eventId: inboxEvents.eventId });
  });

  const insertScheduleFired = Effect.fnUntraced(function* insertScheduleFired({
    _tag,
    ...fired
  }: ScheduleFired) {
    return yield* database
      .insert(inboxEvents)
      .values({ ...(yield* newPendingRow()), kind: _tag, ...fired })
      .onConflictDoNothing({
        target: [inboxEvents.scheduleId, inboxEvents.dueAt],
      })
      .returning({ eventId: inboxEvents.eventId });
  });

  const insertApprovalAnswered = Effect.fnUntraced(
    function* insertApprovalAnswered({ _tag, ...answered }: ApprovalAnswered) {
      return yield* database
        .insert(inboxEvents)
        .values({ ...(yield* newPendingRow()), kind: _tag, ...answered })
        .onConflictDoNothing({
          target: [inboxEvents.channel, inboxEvents.pressId],
        })
        .returning({ eventId: inboxEvents.eventId });
    }
  );

  const inserted = (event: Event) => {
    if (event._tag === "OwnerMessage") {
      return insertOwnerMessage(event);
    }
    return event._tag === "ScheduleFired"
      ? insertScheduleFired(event)
      : insertApprovalAnswered(event);
  };

  const insert = (event: Event) =>
    inserted(event).pipe(Effect.map((rows) => rows.at(0)?.eventId));

  const storeEvent = (event: Event) =>
    Effect.gen(function* storeEventEffect() {
      const eventId = yield* insert(event);
      if (eventId === undefined) {
        return Option.none<string>();
      }
      yield* journal.append({ _tag: "EventReceived", eventId });
      if (event._tag === "ScheduleFired") {
        yield* journal.append({
          _tag: "ScheduleFired",
          eventId,
          scheduleId: event.scheduleId,
          dueAt: event.dueAt,
        });
      }
      return Option.some(eventId);
    });

  const store = (event: Event) =>
    storeEvent(event).pipe(
      Effect.map((eventId): StoreResult =>
        Option.isSome(eventId) ? "stored" : "duplicate"
      )
    );

  const pending = database
    .select()
    .from(inboxEvents)
    .where(eq(inboxEvents.state, "pending"))
    .orderBy(asc(inboxEvents.sequence))
    .pipe(Effect.map((rows) => ownerEventsFirst(rows.map(toInboxEvent))));

  const ownerMessageRowsWithId = (eventId: string) =>
    database
      .select()
      .from(inboxEvents)
      .where(
        and(
          eq(inboxEvents.kind, "OwnerMessage"),
          eq(inboxEvents.eventId, eventId)
        )
      );

  const ownerMessagesWithIds = (eventIds: readonly string[]) =>
    Effect.all(eventIds.map((eventId) => ownerMessageRowsWithId(eventId))).pipe(
      Effect.map((rows) =>
        rows
          .flat()
          .toSorted((left, right) => left.sequence - right.sequence)
          .map(toInboxEvent)
          .filter(
            (event): event is OwnerMessageEvent => event._tag === "OwnerMessage"
          )
      )
    );

  const settle =
    (state: "done" | "failed") => (events: readonly InboxEvent[]) =>
      database.transaction(() =>
        Effect.forEach(
          events,
          (event) =>
            database
              .update(inboxEvents)
              .set({ state })
              .where(eq(inboxEvents.eventId, event.eventId)),
          { discard: true }
        ).pipe(
          Effect.andThen(
            progress.forgetSettled(events.map((event) => event.eventId))
          )
        )
      );

  const { burstIsDue, burstGrewSince } = makeBurstWaitQueries(database);

  return {
    store,
    storeEvent,
    pending,
    ownerMessagesWithIds,
    burstIsDue,
    burstGrewSince,
    markDone: settle("done"),
    markFailed: settle("failed"),
  };
});

export class Inbox extends Context.Service<
  Inbox,
  Effect.Success<typeof makeInbox>
>()("Inbox") {
  static readonly layer = Layer.effect(Inbox, makeInbox);
}
