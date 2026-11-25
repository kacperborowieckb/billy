import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import type { OutgoingReaction as Reaction } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { EventTurnTrace } from "../tracing/turn-trace.ts";
import { lastOf, latestPlanOf, textPlanOf } from "./delivery-plans.ts";
import { sendPlanned } from "./delivery-send.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import type { TurnSession } from "./turn-session.ts";

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

export const unconfirmedSendReason =
  "A send started but Telegram did not confirm it, so the agent did not send again";

export type DeliveryState =
  | { readonly _tag: "Unsent" }
  | { readonly _tag: "Silent" }
  | {
      readonly _tag: "Sent";
      readonly text: string | undefined;
      readonly reaction: string | undefined;
      readonly channelMessageId: string;
    }
  | {
      readonly _tag: "SendFailed";
      readonly text: string | undefined;
      readonly reason: string;
    }
  | { readonly _tag: "Unconfirmed"; readonly text: string | undefined }
  | { readonly _tag: "ReactionUnconfirmed"; readonly reaction: Reaction }
  | {
      readonly _tag: "SendFailureRecorded";
      readonly text: string | undefined;
      readonly reason: string;
    }
  | { readonly _tag: "FailedNoticePending" }
  | { readonly _tag: "FailedNoticeSent"; readonly text: string }
  | {
      readonly _tag: "FailedNoticeRefused";
      readonly text: string | undefined;
      readonly reason: string;
    }
  | {
      readonly _tag: "FailedNoticeUnconfirmed";
      readonly text: string | undefined;
    };

const failedStateOf = (entries: readonly JournalEntry[]): DeliveryState => {
  const hasSendStarted = entries.some(
    (entry) => entry.record._tag === "SendStarted"
  );
  const planned = textPlanOf(entries);
  const sent = lastOf(entries, "ReplySent");
  const sendFailed = lastOf(entries, "ReplyFailed");
  const turnFailed = lastOf(entries, "TurnFailed");
  const firstPlanned = entries.find(
    ({ record }) => record._tag === "ReplyPlanned"
  );
  const lastTurnFailed = entries.findLast(
    (entry) => entry.record._tag === "TurnFailed"
  );
  const reason = turnFailed?.reason ?? "";

  if (
    sendFailed !== undefined &&
    firstPlanned !== undefined &&
    lastTurnFailed !== undefined &&
    firstPlanned.sequence < lastTurnFailed.sequence
  ) {
    return { _tag: "SendFailureRecorded", text: planned?.text, reason };
  }
  if (!hasSendStarted && sendFailed === undefined) {
    return { _tag: "FailedNoticePending" };
  }
  if (sent !== undefined && planned !== undefined) {
    return { _tag: "FailedNoticeSent", text: planned.text };
  }
  return sendFailed === undefined
    ? { _tag: "FailedNoticeUnconfirmed", text: planned?.text }
    : { _tag: "FailedNoticeRefused", text: planned?.text, reason };
};

export const deliveryStateOfEntries = (
  entries: readonly JournalEntry[]
): DeliveryState => {
  const hasTag = (tag: JournalEntry["record"]["_tag"]) =>
    entries.some((entry) => entry.record._tag === tag);
  const { planned, reaction } = latestPlanOf(entries);
  const sent = lastOf(entries, "ReplySent");
  const sendFailed = lastOf(entries, "ReplyFailed");

  if (hasTag("TurnFailed")) {
    return failedStateOf(entries);
  }
  if (hasTag("StayedSilent")) {
    return { _tag: "Silent" };
  }
  if (sent !== undefined) {
    return {
      _tag: "Sent",
      text: planned?.text,
      reaction: reaction?.emoji,
      channelMessageId: sent.channelMessageId,
    };
  }
  if (sendFailed !== undefined) {
    return {
      _tag: "SendFailed",
      text: planned?.text,
      reason: sendFailed.reason,
    };
  }
  if (!hasTag("SendStarted")) {
    return { _tag: "Unsent" };
  }
  return reaction === undefined
    ? { _tag: "Unconfirmed", text: planned?.text }
    : { _tag: "ReactionUnconfirmed", reaction };
};

export const deliveryStateOf = (eventId: string) =>
  Journal.pipe(
    Effect.flatMap((journal) => journal.readForEvent(eventId)),
    Effect.map(deliveryStateOfEntries)
  );

export const send = Effect.fnUntraced(function* send(
  event: InboxEvent,
  text: string,
  replyTo: InboxEvent = event
) {
  const channel = yield* Channel;
  return yield* sendPlanned({
    event,
    text,
    replyTo,
    attempt: (destination) => channel.send({ ...destination, text }),
  });
});

const appendEntry = (record: JournalEntry["record"]) =>
  Journal.pipe(Effect.flatMap((journal) => journal.append(record)));

export const staySilent = (event: InboxEvent) =>
  appendEntry({ _tag: "StayedSilent", eventId: event.eventId });

export const recordFailure = (event: InboxEvent, reason: string) =>
  appendEntry({ _tag: "TurnFailed", eventId: event.eventId, reason });

export const fail = Effect.fnUntraced(function* fail(
  event: InboxEvent,
  reason: string
) {
  const inbox = yield* Inbox;

  yield* recordFailure(event, reason);
  yield* inbox.markFailed([event]);
});

interface FailureNotice {
  readonly event: InboxEvent;
  readonly session: TurnSession;
  readonly text: string;
  readonly replyTo?: InboxEvent | undefined;
}

export const sendFailureNotice = Effect.fnUntraced(function* sendFailureNotice({
  event,
  session,
  text,
  replyTo = event,
}: FailureNotice) {
  const inbox = yield* Inbox;

  const delivery = yield* send(event, text, replyTo);
  if (delivery._tag !== "Failed") {
    yield* session.rememberFailureNotice(event.eventId, text);
  }
  yield* inbox.markFailed([event]);
});

interface NoticedFailure extends Omit<FailureNotice, "text"> {
  readonly reason: string;
}

export const failWithNotice = Effect.fnUntraced(function* failWithNotice({
  event,
  session,
  reason,
  replyTo,
}: NoticedFailure) {
  yield* recordFailure(event, reason);
  yield* sendFailureNotice({
    event,
    session,
    text: honestFailureText,
    replyTo,
  });
});

export const recordUnconfirmedSend = (event: InboxEvent) =>
  appendEntry({
    _tag: "ReplyFailed",
    eventId: event.eventId,
    reason: unconfirmedSendReason,
  });

interface EventOutcome {
  readonly trace: EventTurnTrace;
  readonly metric: OperatorMetric;
}

export const recordOutcome = Effect.fnUntraced(function* recordOutcome({
  trace,
  metric,
}: EventOutcome) {
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;

  const recorded = yield* traces.readForEvent(trace.eventId);
  if (recorded.length > 0) {
    return;
  }
  yield* metrics.record(metric);
  yield* traces.record(trace);
});
