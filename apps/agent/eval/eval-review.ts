import { Effect, Layer } from "effect";

import { modelReviewerLayer } from "../src/auto-review/model-reviewer.ts";
import type { ReviewRequest } from "../src/auto-review/review-request.ts";
import { Reviewer, reviewWithin } from "../src/auto-review/reviewer.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import type { Usage } from "../src/model-gateway/usage-ledger.ts";
import type { OwnerId } from "../src/owner-id.ts";
import {
  decodeTurnEnv,
  liveModelGateway,
} from "../src/personal-agent/turn-services.ts";
import type { ReviewEvalResult } from "./eval-contract.ts";
import { collectedUsageLedger, observedUsageOf } from "./eval-usage.ts";

export const reviewPlannedCall = Effect.fnUntraced(function* reviewPlannedCall(
  env: Env,
  ownerId: OwnerId,
  request: ReviewRequest
) {
  const config = yield* decodeTurnEnv(env);
  const collected: Usage[] = [];
  const reviewed = yield* Reviewer.pipe(
    Effect.flatMap((reviewer) =>
      reviewWithin(
        defaultBehaviorConfig.autoReviewTimeoutMillis,
        reviewer.review(request)
      )
    ),
    Effect.map((answer) => ({ answer, failure: null })),
    Effect.catchTag("ReviewFailed", ({ cause }) =>
      Effect.succeed({ answer: null, failure: cause })
    ),
    Effect.provide(
      modelReviewerLayer.pipe(
        Layer.provide(liveModelGateway(config, ownerId)),
        Layer.provide(collectedUsageLedger(collected))
      )
    )
  );
  return {
    ...reviewed,
    usage: collected.map((usage) => observedUsageOf("auto_review", usage)),
  } satisfies ReviewEvalResult;
});
