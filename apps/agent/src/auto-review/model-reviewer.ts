import { Effect, Layer, Schema } from "effect";

import { fixedTurnTrust } from "../approval/turn-trust.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { ReviewFailed } from "./review-failed.ts";
import { ReviewRequestSchema } from "./review-request.ts";
import type { ReviewRequest } from "./review-request.ts";
import { reviewerInstructions } from "./reviewer-instructions.ts";
import { ReviewAnswerSchema, Reviewer } from "./reviewer.ts";

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(ReviewRequestSchema)
);

const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ReviewAnswerSchema)
);

const modelFailed = () => new ReviewFailed({ cause: "model_failed" });

const makeModelReviewer = Effect.gen(function* makeModelReviewerEffect() {
  const gateway = yield* ModelGateway;

  const review = (request: ReviewRequest, eventId?: string) =>
    gateway
      .generate({
        task: "auto_review",
        ...(eventId === undefined ? {} : { eventId }),
        system: reviewerInstructions,
        messages: [{ role: "user", content: encodeRequest(request) }],
        trust: fixedTurnTrust("untrusted"),
        asksOwnerForApproval: false,
        stepLimit: 1,
      })
      .pipe(
        Effect.mapError(modelFailed),
        Effect.flatMap((reply) =>
          decodeAnswer(reply.text.trim()).pipe(
            Effect.mapError(() => new ReviewFailed({ cause: "invalid_answer" }))
          )
        )
      );

  return { review };
});

export const modelReviewerLayer = Layer.effect(Reviewer, makeModelReviewer);
