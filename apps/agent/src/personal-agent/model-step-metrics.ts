import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { ModelStep } from "../model-gateway/model-step.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { ModelTurnKind } from "./model-turn.ts";
import {
  minutesBetween,
  plannedMissOf,
  PrefixCacheSessions,
  requestPrefixOf,
} from "./prefix-cache.ts";
import type { EarlierCall } from "./prefix-cache.ts";
import { stepsOf } from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

interface ModelStepsOfTurn<Failure, Requirements> {
  readonly ownerId: OwnerId;
  readonly kind: ModelTurnKind<Failure, Requirements>;
  readonly stepsUsed: number;
  readonly system: string;
  readonly ownerContext: ModelMessage;
  readonly outcome: ModelOutcome;
}

const modelIdOf = (outcome: ModelOutcome) =>
  outcome._tag === "Replied" ? outcome.reply.modelId : outcome.error.modelId;

const earlierCallAtOf = (
  steps: readonly ModelStep[],
  index: number,
  earlier: EarlierCall | undefined
) =>
  index === 0 ? earlier?.lastCallAtMillis : steps[index - 1]?.finishedAtMillis;

export const recordModelSteps = Effect.fnUntraced(function* recordModelSteps<
  Failure,
  Requirements,
>({
  ownerId,
  kind,
  stepsUsed,
  system,
  ownerContext,
  outcome,
}: ModelStepsOfTurn<Failure, Requirements>) {
  const steps = stepsOf(outcome);
  const lastStep = steps.at(-1);
  if (lastStep === undefined) {
    return;
  }
  const turnKind = kind.task;
  const { eventId } = kind.event;
  const modelId = modelIdOf(outcome);
  const prefix = yield* requestPrefixOf(system, kind.tools, ownerContext);
  const metrics = yield* OperatorMetrics;
  const sessions = yield* PrefixCacheSessions;
  const earlier = yield* sessions.earlierCallOf(turnKind);
  yield* Effect.forEach(
    steps,
    (step, index) => {
      const earlierCallAt = earlierCallAtOf(steps, index, earlier);
      return metrics.record({
        kind: "model_step",
        ownerId,
        eventId,
        turnKind,
        modelId,
        stepNumber: stepsUsed + index + 1,
        usage: step.usage,
        minutesSinceEarlierCall:
          earlierCallAt === undefined
            ? undefined
            : minutesBetween(earlierCallAt, step.finishedAtMillis),
        plannedMiss:
          index === 0
            ? plannedMissOf(earlier, prefix, step.finishedAtMillis)
            : undefined,
      });
    },
    { discard: true }
  );
  yield* sessions.recordCall(turnKind, prefix, lastStep.finishedAtMillis);
});
