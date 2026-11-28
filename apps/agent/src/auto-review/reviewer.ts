import { Context, Effect, Schema } from "effect";

import { ReviewFailed } from "./review-failed.ts";
import type { ReviewRequest } from "./review-request.ts";

const NonBlankString = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/u))
);

export const ReviewAnswerSchema = Schema.Union([
  Schema.Struct({ answer: Schema.Literal("allow") }),
  Schema.Struct({
    answer: Schema.Literals(["ask", "refuse"]),
    reason: NonBlankString,
  }),
]);

export type ReviewAnswer = typeof ReviewAnswerSchema.Type;

export class Reviewer extends Context.Service<
  Reviewer,
  {
    readonly review: (
      request: ReviewRequest,
      eventId?: string
    ) => Effect.Effect<ReviewAnswer, ReviewFailed>;
  }
>()("Reviewer") {}

export const reviewWithin = (
  timeoutMillis: number,
  review: Effect.Effect<ReviewAnswer, ReviewFailed>
) =>
  review.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () => Effect.fail(new ReviewFailed({ cause: "timed_out" })),
    })
  );
