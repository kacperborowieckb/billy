import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { exitWithFailureWhen } from "../exit-code.ts";
import { runReviewSetCommand } from "./run-review-set.ts";

export const reviewSetCommand = Command.make(
  "review-set",
  {
    k: Flag.Int("k").pipe(
      Flag.withSchema(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
      Flag.withDescription(
        "Runs of each case. A case passes only when all k runs pass (pass^k)."
      )
    ),
    caseName: Flag.String("case").pipe(
      Flag.withDescription(
        "The name of a case of control/auto-review/fixed-set.ts. Repeat the flag for several cases. Without it, all cases run."
      ),
      Flag.atLeast(0)
    ),
  },
  ({ k, caseName }) =>
    Effect.gen(function* reviewSetCommandEffect() {
      const passed = yield* runReviewSetCommand({ k, names: caseName });
      yield* exitWithFailureWhen(!passed);
    })
).pipe(
  Command.withDescription(
    "Run the fixed Auto-review cases k times each against the real reviewer model through AI Gateway, and report pass^k, false allows, and tokens. It costs money: run it only with the repository owner's approval. Reads AI_GATEWAY_URL and AI_GATEWAY_TOKEN from the environment or .dev.vars."
  )
);
