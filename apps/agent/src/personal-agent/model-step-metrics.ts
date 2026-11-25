import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
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
import type { SessionTask } from "./storage-values.ts";
import { stepsOf } from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

interface SessionSteps {
  readonly ownerId: OwnerId;
  readonly task: SessionTask;
  readonly eventId: string;
  readonly modelId: string;
  readonly stepsBefore: number;
  readonly request: {
    readonly system: string;
    readonly tools: AgentTools;
    readonly ownerContext: ModelMessage | undefined;
  };
  readonly steps: readonly ModelStep[];
}

const earlierCallAtOf = (
  steps: readonly ModelStep[],
  index: number,
  earlier: EarlierCall | undefined
) =>
  index === 0 ? earlier?.lastCallAtMillis : steps[index - 1]?.calledAtMillis;

export const recordSessionSteps = Effect.fnUntraced(
  function* recordSessionSteps({
    ownerId,
    task,
    eventId,
    modelId,
    stepsBefore,
    request,
    steps,
  }: SessionSteps) {
    const lastStep = steps.at(-1);
    if (lastStep === undefined) {
      return;
    }
    const prefix = yield* requestPrefixOf(
      request.system,
      request.tools,
      request.ownerContext
    );
    const metrics = yield* OperatorMetrics;
    const sessions = yield* PrefixCacheSessions;
    const earlier = yield* sessions.earlierCallOf(task);
    yield* Effect.forEach(
      steps,
      (step, index) => {
        const earlierCallAt = earlierCallAtOf(steps, index, earlier);
        return metrics.record({
          kind: "model_step",
          ownerId,
          eventId,
          task,
          modelId,
          stepNumber: stepsBefore + index + 1,
          usage: step.usage,
          minutesSinceEarlierCall:
            earlierCallAt === undefined
              ? undefined
              : minutesBetween(earlierCallAt, step.calledAtMillis),
          plannedMiss:
            index === 0
              ? plannedMissOf(earlier, prefix, step.calledAtMillis)
              : undefined,
        });
      },
      { discard: true }
    );
    yield* sessions.recordCall(task, prefix, lastStep.calledAtMillis);
  },
  Effect.catchCause(() =>
    Effect.logWarning("The model step metrics could not be recorded")
  )
);

interface TurnSteps<Failure, Requirements> {
  readonly ownerId: OwnerId;
  readonly kind: ModelTurnKind<Failure, Requirements>;
  readonly stepsUsed: number;
  readonly system: string;
  readonly ownerContext: ModelMessage;
  readonly outcome: ModelOutcome;
}

export const recordModelSteps = <Failure, Requirements>({
  ownerId,
  kind,
  stepsUsed,
  system,
  ownerContext,
  outcome,
}: TurnSteps<Failure, Requirements>) =>
  recordSessionSteps({
    ownerId,
    task: kind.task,
    eventId: kind.event.eventId,
    modelId:
      outcome._tag === "Replied"
        ? outcome.reply.modelId
        : outcome.error.modelId,
    stepsBefore: stepsUsed,
    request: { system, tools: kind.tools, ownerContext },
    steps: stepsOf(outcome),
  });

interface CompactionSteps {
  readonly ownerId: OwnerId;
  readonly compactionId: string;
  readonly system: string;
  readonly reply: {
    readonly modelId: string;
    readonly steps: readonly ModelStep[];
  };
}

export const recordCompactionSteps = ({
  ownerId,
  compactionId,
  system,
  reply,
}: CompactionSteps) =>
  recordSessionSteps({
    ownerId,
    task: "compaction",
    eventId: compactionId,
    modelId: reply.modelId,
    stepsBefore: 0,
    request: { system, tools: noTools, ownerContext: undefined },
    steps: reply.steps,
  });
