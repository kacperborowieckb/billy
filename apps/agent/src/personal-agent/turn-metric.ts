import { Clock, Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import type { OutcomeKind } from "./storage-values.ts";
import { stepsOf, usageOfOutcome } from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

interface TurnMetricInput {
  readonly ownerId: OwnerId;
  readonly eventId: string;
  readonly outcome: ModelOutcome;
  readonly result: Extract<OperatorMetric, { kind: "turn" }>["result"];
  readonly outcomeKind?: OutcomeKind | undefined;
  readonly startedAt: number;
  readonly restartCount?: number;
}

export const recordTurnMetric = ({
  ownerId,
  eventId,
  outcome,
  result,
  outcomeKind,
  startedAt,
  restartCount = 0,
}: TurnMetricInput) =>
  Effect.gen(function* recordTurnMetricEffect() {
    const metrics = yield* OperatorMetrics;
    const now = yield* Clock.currentTimeMillis;
    yield* metrics.record({
      kind: "turn",
      ownerId,
      eventId,
      result,
      outcome: outcomeKind,
      latencyMillis: now - startedAt,
      modelId:
        outcome._tag === "Replied"
          ? outcome.reply.modelId
          : outcome.error.modelId,
      usage: usageOfOutcome(outcome),
      stepCount: stepsOf(outcome).length,
      toolCallCount: stepsOf(outcome).flatMap((step) => step.toolCalls).length,
      restartCount,
    });
  });
