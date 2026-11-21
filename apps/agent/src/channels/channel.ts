import { Context } from "effect";
import type { Effect } from "effect";

import type { TypingNotShown } from "./typing-not-shown.ts";

export interface OutgoingMessage {
  readonly conversationId: string;
  readonly inReplyTo?: string;
  readonly text: string;
}

export interface ApprovalRequest {
  readonly pendingApprovalId: string;
  readonly summary: string;
}

export interface ApprovalMessage {
  readonly pendingApprovalId: string;
  readonly channelMessageId: string;
}

export type ApprovalDelivery =
  | {
      readonly _tag: "Confirmed";
      readonly channelMessageId: string;
      readonly approvalMessages: readonly ApprovalMessage[];
    }
  | { readonly _tag: "Failed"; readonly reason: string };

export interface OutgoingApprovalMessage {
  readonly conversationId: string;
  readonly inReplyTo?: string;
  readonly text: string;
  readonly approvals: readonly [ApprovalRequest, ...ApprovalRequest[]];
}

export interface OutgoingReaction {
  readonly conversationId: string;
  readonly channelMessageId: string;
  readonly emoji: string;
}

export type Delivery =
  | { readonly _tag: "Confirmed"; readonly channelMessageId: string }
  | { readonly _tag: "Failed"; readonly reason: string };

export type ReactionDelivery =
  | Delivery
  | { readonly _tag: "Unconfirmed"; readonly reason: string };

export class Channel extends Context.Service<
  Channel,
  {
    readonly send: (message: OutgoingMessage) => Effect.Effect<Delivery>;
    readonly sendWithApprovals: (
      message: OutgoingApprovalMessage
    ) => Effect.Effect<ApprovalDelivery>;
    readonly react: (
      reaction: OutgoingReaction
    ) => Effect.Effect<ReactionDelivery>;
    readonly allowedReaction: (emoji: string) => string | undefined;
    readonly showTyping: (
      conversationId: string
    ) => Effect.Effect<void, TypingNotShown>;
  }
>()("Channel") {}
