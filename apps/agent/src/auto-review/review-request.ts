import { Schema } from "effect";

const sentMessageFields = {
  sentAt: Schema.String,
  current: Schema.Boolean,
};

export const ReviewedMessageSchema = Schema.Union([
  Schema.Struct({ ...sentMessageFields, text: Schema.String }),
  Schema.Struct({ ...sentMessageFields, forwarded: Schema.Literal(true) }),
]);

export type ReviewedMessage = typeof ReviewedMessageSchema.Type;

export const ReviewRequestSchema = Schema.Struct({
  currentTime: Schema.String,
  ownerMessages: Schema.Array(ReviewedMessageSchema),
  plannedCall: Schema.Struct({ tool: Schema.String, input: Schema.Unknown }),
});

export type ReviewRequest = typeof ReviewRequestSchema.Type;

export const holdsOwnerWords = ({ ownerMessages }: ReviewRequest) =>
  ownerMessages.some((message) => "text" in message);
