import { Schema } from "effect";

import { ReviewRequestSchema } from "../src/auto-review/review-request.ts";
import type { ReviewRequest } from "../src/auto-review/review-request.ts";
import { reviewerMarker } from "../src/auto-review/reviewer-instructions.ts";
import type { ReviewAnswer } from "../src/auto-review/reviewer.ts";
import type { ChatCompletionBodySchema } from "./fake-completion.ts";
import { fakeReminderPrefix } from "./fake-schedule.ts";

type ChatMessages = (typeof ChatCompletionBodySchema.Type)["messages"];

export interface FakeReview {
  readonly tool: string;
  readonly answer: ReviewAnswer["answer"];
}

export const fakeAskReason = "Your messages do not ask for this change.";

export const isFakeReviewRequest = (messages: ChatMessages) =>
  messages.some(
    (message) =>
      message.role === "system" &&
      String(message.content).startsWith(reviewerMarker)
  );

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReviewRequestSchema)
);

const ReminderInputSchema = Schema.Struct({
  action: Schema.Struct({
    _tag: Schema.Literal("SendText"),
    text: Schema.String,
  }),
});

const isReminderInput = Schema.is(ReminderInputSchema);

const ownerAskedForReminder = ({
  ownerMessages,
  plannedCall,
}: ReviewRequest) => {
  const { input, tool } = plannedCall;
  if (tool !== "set_schedule" || !isReminderInput(input)) {
    return false;
  }
  return ownerMessages.some(
    (message) =>
      message.current &&
      "text" in message &&
      message.text === `${fakeReminderPrefix}${input.action.text}`
  );
};

const defaultAnswerFor = (request: ReviewRequest): ReviewAnswer =>
  ownerAskedForReminder(request)
    ? { answer: "allow" }
    : { answer: "ask", reason: fakeAskReason };

export const fakeReviewOf = (
  messages: ChatMessages,
  scripted: ReviewAnswer | undefined
) => {
  const request = decodeRequest(
    String(messages.find((message) => message.role === "user")?.content)
  );
  const answer = scripted ?? defaultAnswerFor(request);
  return {
    review: {
      tool: request.plannedCall.tool,
      answer: answer.answer,
    } satisfies FakeReview,
    message: { role: "assistant", content: JSON.stringify(answer) },
  };
};
