import { Console, Effect } from "effect";

import { defaultBehaviorConfig } from "../../src/behavior/behavior-config.ts";
import { routeOf } from "../../src/model-gateway/model-routes.ts";
import type { ModelRoute } from "../../src/model-gateway/model-routes.ts";
import { realModelAccess } from "../eval/eval-command.ts";
import { evalWorkerClient } from "../eval/eval-worker-client.ts";
import { evalWorkerMain } from "../eval/local-eval-agent.ts";
import type { ModelAccess } from "../eval/local-eval-agent.ts";
import { startLocalWorker, temporarySecrets } from "../local-worker.ts";
import { configuredModelRoutes } from "../model-routes-config.ts";
import { fixedReviewCases } from "./fixed-set.ts";
import type { ReviewCase } from "./review-case.ts";
import { caseResultOf, renderReviewReport } from "./review-report.ts";
import { UnknownReviewCase } from "./unknown-review-case.ts";

const reviewOwnerId = "auto-review-set";

export const runReviewSet = Effect.fnUntraced(function* runReviewSet({
  cases,
  k,
  model,
}: {
  readonly cases: readonly ReviewCase[];
  readonly k: number;
  readonly model: ModelAccess;
}) {
  const secrets = {
    ...temporarySecrets(),
    AI_GATEWAY_TOKEN: model.aiGatewayToken,
  };
  const workerUrl = yield* startLocalWorker({
    main: evalWorkerMain,
    vars: {
      ...(model.modelRoutes === undefined
        ? {}
        : { MODEL_ROUTES: model.modelRoutes }),
      AI_GATEWAY_URL: model.aiGatewayUrl,
    },
    secrets,
  });
  const client = evalWorkerClient({
    workerUrl,
    operatorToken: secrets.OPERATOR_TOKEN,
    turnTimeoutMillis: defaultBehaviorConfig.autoReviewTimeoutMillis,
  });
  const runsOf = ({ request }: ReviewCase) =>
    Effect.all(
      Array.from({ length: k }, () =>
        client.review({ ownerId: reviewOwnerId, request })
      )
    );
  return yield* Effect.all(
    cases.map((reviewCase) =>
      runsOf(reviewCase).pipe(
        Effect.map((runs) => caseResultOf(reviewCase, runs))
      )
    )
  );
});

const selectedCases = (names: readonly string[]) => {
  const unknown = names.filter(
    (name) => !fixedReviewCases.some((reviewCase) => reviewCase.name === name)
  );
  if (unknown.length > 0) {
    return Effect.fail(new UnknownReviewCase({ names: unknown }));
  }
  return Effect.succeed(
    names.length === 0
      ? fixedReviewCases
      : fixedReviewCases.filter(({ name }) => names.includes(name))
  );
};

const renderPlan = (caseCount: number, k: number, route: ModelRoute) =>
  `Auto-review set: ${caseCount} cases, ${k} runs of each, ${caseCount * k} reviews on ${route.model} (reasoning effort ${route.reasoningEffort}).`;

export const runReviewSetCommand = Effect.fnUntraced(
  function* runReviewSetCommand({
    k,
    names,
  }: {
    readonly k: number;
    readonly names: readonly string[];
  }) {
    const cases = yield* selectedCases(names);
    const model = yield* realModelAccess;
    const route = routeOf(configuredModelRoutes(), "auto_review");
    yield* Console.log(renderPlan(cases.length, k, route));
    const results = yield* runReviewSet({ cases, k, model });
    yield* Console.log(renderReviewReport(results, k));
    return results.every((result) => result.passed);
  },
  Effect.scoped
);
