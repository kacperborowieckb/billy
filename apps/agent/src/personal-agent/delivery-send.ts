import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import type {
  ApprovalRequest,
  Delivery,
  ReactionDelivery,
} from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import type { InboxEvent } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";

export const noOwnerConversationReason =
  "The Owner has no Channel conversation to send to yet";

export const recordSend = Effect.fnUntraced(function* recordSend<
  Attempted extends ReactionDelivery,
  Requirements,
>(event: InboxEvent, attempt: Effect.Effect<Attempted, never, Requirements>) {
  const journal = yield* Journal;
  const redactor = yield* Redactor;

  yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
  const delivery: ReactionDelivery = yield* attempt;

  if (delivery._tag === "Unconfirmed") {
    return delivery as Extract<Attempted, { readonly _tag: "Unconfirmed" }>;
  }
  if (delivery._tag === "Failed") {
    const reason = redactor.redact(delivery.reason);
    yield* journal.append({
      _tag: "ReplyFailed",
      eventId: event.eventId,
      reason,
    });
    return { _tag: "Failed", reason } as const;
  }
  yield* journal.append({
    _tag: "ReplySent",
    eventId: event.eventId,
    channelMessageId: delivery.channelMessageId,
  });
  return {
    _tag: "Confirmed",
    channelMessageId: delivery.channelMessageId,
  } as const;
});

const destinationOf = Effect.fnUntraced(function* destinationOf(
  event: InboxEvent
) {
  if (event._tag === "OwnerMessage") {
    return {
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
    };
  }
  const ownerConversation = yield* OwnerChannelConversation;
  const current = yield* ownerConversation.current;
  return current === undefined
    ? undefined
    : { conversationId: current.conversationId };
});

export type Destination = NonNullable<
  Effect.Success<ReturnType<typeof destinationOf>>
>;

export interface PlannedSend {
  readonly event: InboxEvent;
  readonly text: string;
  readonly replyTo: InboxEvent;
  readonly attempt: (destination: Destination) => Effect.Effect<Delivery>;
}

export const sendPlanned = Effect.fnUntraced(function* sendPlanned({
  event,
  text,
  replyTo,
  attempt,
}: PlannedSend) {
  const journal = yield* Journal;

  yield* journal.append({
    _tag: "ReplyPlanned",
    eventId: event.eventId,
    text,
  });
  const destination = yield* destinationOf(replyTo);
  if (destination === undefined) {
    yield* journal.append({
      _tag: "ReplyFailed",
      eventId: event.eventId,
      reason: noOwnerConversationReason,
    });
    return { _tag: "Failed", reason: noOwnerConversationReason } as const;
  }
  return yield* recordSend(event, attempt(destination));
});

export interface ApprovalSend {
  readonly event: InboxEvent;
  readonly text: string;
  readonly approvals: readonly [ApprovalRequest, ...ApprovalRequest[]];
  readonly replyTo: InboxEvent;
}

export const sendWithApprovals = Effect.fnUntraced(function* sendWithApprovals({
  event,
  text,
  approvals,
  replyTo,
}: ApprovalSend) {
  const channel = yield* Channel;
  return yield* sendPlanned({
    event,
    text,
    replyTo,
    attempt: (destination) =>
      channel.sendWithApprovals({ ...destination, text, approvals }),
  });
});
