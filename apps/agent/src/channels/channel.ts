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

export interface ShownApproval extends ApprovalRequest {
  readonly channelMessageId: string;
  readonly status?: string;
}

export interface ApprovalMessageEdit {
  readonly conversationId: string;
  readonly channelMessageId: string;
  readonly turnApprovals: readonly ShownApproval[];
}

export interface ApprovalPressAnswer {
  readonly pressId: string;
  readonly notice?: string;
}

export interface OutgoingDocument {
  readonly conversationId: string;
  readonly filename: string;
  readonly text: string;
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
    readonly editApprovalMessage: (
      edit: ApprovalMessageEdit
    ) => Effect.Effect<Delivery>;
    readonly sendDocument: (
      document: OutgoingDocument
    ) => Effect.Effect<Delivery>;
    readonly answerPress: (answer: ApprovalPressAnswer) => Effect.Effect<void>;
    readonly react: (
      reaction: OutgoingReaction
    ) => Effect.Effect<ReactionDelivery>;
    readonly allowedReaction: (emoji: string) => string | undefined;
    readonly showTyping: (
      conversationId: string
    ) => Effect.Effect<void, TypingNotShown>;
  }
>()("Channel") {}
