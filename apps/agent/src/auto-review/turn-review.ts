import { Effect } from "effect";

import { holdsOperatorSecret } from "../approval/draft-approval.ts";
import type { ReviewVerdict } from "../approval/tool-gate.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import type {
  CallReview,
  ReviewedCall,
} from "../model-gateway/tool-approval.ts";
import { tokensSpentToday } from "../personal-agent/scheduled-task-budget.ts";
import type { ReviewFallback } from "../personal-agent/storage-values.ts";
import { Redactor } from "../tracing/redactor.ts";
import type { ReviewRecord } from "./review-record.ts";
import { reviewRequestOf } from "./review-request-of-turn.ts";
import { holdsOwnerWords } from "./review-request.ts";
import { Reviewer, reviewWithin } from "./reviewer.ts";
import type { ReviewAnswer } from "./reviewer.ts";
import { shownReviewerReason } from "./shown-reviewer-reason.ts";

export const refusedByReviewReason = (reason: string | undefined) =>
  [
    "A safety check refused this call, so it did not run.",
    ...(reason === undefined ? [] : [`Its reason: ${reason}`]),
    "Do not try it again. Tell the Owner that you did not do it.",
  ].join(" ");

export const reviewStoppedNotice =
  "I stopped here: a safety check refused several changes that your messages did not ask for, so I did not make them. If you want one of them, tell me directly.";

interface Reviewed {
  readonly answer: ReviewAnswer["answer"];
  readonly reason?: string | undefined;
  readonly fallback?: ReviewFallback;
}

const askBecause = (fallback: ReviewFallback): Reviewed => ({
  answer: "ask",
  fallback,
});

const verdictOfReviewed = ({ answer, reason }: Reviewed): ReviewVerdict => {
  if (answer === "allow") {
    return { _tag: "Allow" };
  }
  if (answer === "refuse") {
    return { _tag: "Refuse", reason: refusedByReviewReason(reason) };
  }
  return reason === undefined ? { _tag: "Ask" } : { _tag: "Ask", reason };
};

const reviewByReviewer = Effect.fnUntraced(function* reviewByReviewer(
  eventId: string,
  behavior: BehaviorConfig,
  call: ReviewedCall
) {
  const redactor = yield* Redactor;
  const reviewer = yield* Reviewer;
  if (holdsOperatorSecret(redactor, call.input)) {
    return askBecause("operator_secret");
  }
  const spent = yield* tokensSpentToday("auto_review", behavior);
  if (spent >= behavior.autoReviewDailyTokenBudget) {
    return askBecause("over_budget");
  }
  const request = yield* reviewRequestOf({
    turnEventId: eventId,
    call,
    behavior,
    redactor,
  });
  if (!holdsOwnerWords(request)) {
    return askBecause("no_owner_words");
  }
  return yield* reviewWithin(
    behavior.autoReviewTimeoutMillis,
    reviewer.review(request, eventId)
  ).pipe(
    Effect.map((answer): Reviewed =>
      answer.answer === "allow"
        ? answer
        : {
            answer: answer.answer,
            reason: shownReviewerReason(redactor, answer.reason),
          }
    ),
    Effect.catchTag("ReviewFailed", ({ cause }) =>
      Effect.succeed(askBecause(cause))
    )
  );
});

export interface TurnReview extends CallReview {
  readonly records: () => readonly ReviewRecord[];
  readonly shownText: (replyText: string) => string;
}

export const turnReviewOf = Effect.fnUntraced(function* turnReviewOf(
  eventId: string,
  behavior: BehaviorConfig
) {
  const journal = yield* Journal;
  const records: ReviewRecord[] = [];
  const stopsTurn = () =>
    records.filter((record) => record.answer === "refuse").length >=
    behavior.autoReviewMaxRefusals;

  const recorded = Effect.fnUntraced(function* recorded(
    { toolCallId, toolName }: ReviewedCall,
    { answer, reason, fallback }: Reviewed
  ) {
    const fallbackField = fallback === undefined ? {} : { fallback };
    yield* journal.append({
      _tag: "AutoReviewed",
      eventId,
      toolName,
      answer,
      ...fallbackField,
    });
    records.push({
      toolCallId,
      toolName,
      answer,
      ...(reason === undefined ? {} : { reason }),
      ...fallbackField,
    });
    return verdictOfReviewed({ answer, reason });
  });

  const reviewed = (call: ReviewedCall) =>
    reviewByReviewer(eventId, behavior, call).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("The Auto-review did not run", cause).pipe(
          Effect.as(askBecause("review_failed"))
        )
      ),
      Effect.flatMap((outcome) => recorded(call, outcome)),
      Effect.catchCause((cause) =>
        Effect.logError("The Auto-review was not recorded", cause).pipe(
          Effect.as<ReviewVerdict>({ _tag: "Ask" })
        )
      )
    );

  const context =
    yield* Effect.context<Effect.Services<ReturnType<typeof reviewed>>>();

  return {
    verdictOf: (call) => reviewed(call).pipe(Effect.provide(context)),
    stopsTurn,
    records: () => [...records],
    shownText: (replyText) => (stopsTurn() ? reviewStoppedNotice : replyText),
  } satisfies TurnReview;
});
