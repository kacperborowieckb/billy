import { Schema } from "effect";

import { approvalAnswers } from "./personal-agent/storage-values.ts";

export const ownerMessageFields = {
  channel: Schema.Literal("telegram"),
  channelUpdateId: Schema.String,
  conversationId: Schema.String,
  channelMessageId: Schema.String,
  text: Schema.String,
  forwardOrigin: Schema.optionalKey(Schema.String),
  sentAt: Schema.String,
};

export const scheduleFiredFields = {
  scheduleId: Schema.String,
  dueAt: Schema.String,
};

export const approvalAnsweredFields = {
  channel: Schema.Literal("telegram"),
  pressId: Schema.String,
  conversationId: Schema.String,
  channelMessageId: Schema.String,
  pendingApprovalId: Schema.String,
  answer: Schema.Literals(approvalAnswers),
};

export const EventSchema = Schema.TaggedUnion({
  OwnerMessage: ownerMessageFields,
  ScheduleFired: scheduleFiredFields,
  ApprovalAnswered: approvalAnsweredFields,
});

export const OwnerMessageSchema = EventSchema.cases.OwnerMessage;

export const ScheduleFiredSchema = EventSchema.cases.ScheduleFired;

export const ApprovalAnsweredSchema = EventSchema.cases.ApprovalAnswered;

export type Event = typeof EventSchema.Type;

export type OwnerMessage = typeof OwnerMessageSchema.Type;

export type ScheduleFired = typeof ScheduleFiredSchema.Type;

export type ApprovalAnswered = typeof ApprovalAnsweredSchema.Type;

export type ApprovalAnswer = ApprovalAnswered["answer"];
