import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import type { ReviewedCall } from "../model-gateway/tool-approval.ts";
import { Inbox } from "../personal-agent/inbox.ts";
import type { OwnerMessageEvent } from "../personal-agent/inbox.ts";
import type { OwnWords } from "../personal-agent/own-words.ts";
import { localTimeOf } from "../time/local-time.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { ReviewedMessage, ReviewRequest } from "./review-request.ts";

const sentAtText = (
  sentAt: string,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  Option.match(timeZone, {
    onNone: () => sentAt,
    onSome: (zone) => localTimeOf(DateTime.makeUnsafe(sentAt), zone),
  });

const currentTimeOf = (
  now: DateTime.Utc,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  Option.match(timeZone, {
    onNone: () =>
      `Current time in UTC: ${DateTime.formatIso(now)}. The time zone of the Owner is not known.`,
    onSome: (zone) =>
      `Current local time of the Owner: ${localTimeOf(now, zone)} (time zone ${DateTime.zoneToString(zone)}).`,
  });

interface MessageView {
  readonly current: boolean;
  readonly timeZone: Option.Option<DateTime.TimeZone>;
  readonly redactor: Redactor["Service"];
}

type SentMessage =
  | OwnWords
  | Pick<OwnerMessageEvent, "text" | "sentAt" | "forwardOrigin">;

const reviewedMessageOf = (
  message: SentMessage,
  { current, timeZone, redactor }: MessageView
): ReviewedMessage => {
  const sent = { sentAt: sentAtText(message.sentAt, timeZone), current };
  return "forwardOrigin" in message && message.forwardOrigin !== undefined
    ? { ...sent, forwarded: true }
    : { ...sent, text: redactor.redact(message.text) };
};

interface PlannedReview {
  readonly turnEventId: string;
  readonly call: ReviewedCall;
  readonly behavior: BehaviorConfig;
  readonly redactor: Redactor["Service"];
}

export const reviewRequestOf = Effect.fnUntraced(function* reviewRequestOf({
  turnEventId,
  call,
  behavior,
  redactor,
}: PlannedReview) {
  const journal = yield* Journal;
  const inbox = yield* Inbox;
  const timeZone = yield* ownerTimeZone(behavior);
  const current = yield* inbox.ownerMessagesWithIds([
    turnEventId,
    ...(yield* journal.eventIdsAnsweredByTurn(turnEventId)),
  ]);
  const earlier = yield* inbox.ownWordsBefore(
    turnEventId,
    behavior.autoReviewRecentOwnerMessages
  );
  const viewOf = (isCurrent: boolean) => (message: SentMessage) =>
    reviewedMessageOf(message, { current: isCurrent, timeZone, redactor });
  return {
    currentTime: currentTimeOf(yield* DateTime.now, timeZone),
    ownerMessages: [
      ...earlier.map(viewOf(false)),
      ...current.map(viewOf(true)),
    ],
    plannedCall: { tool: call.toolName, input: call.input },
  } satisfies ReviewRequest;
});
