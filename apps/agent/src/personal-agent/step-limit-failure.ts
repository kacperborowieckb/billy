import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { ModelTurnKind } from "./model-turn-kind.ts";
import type { ModelTurnResult } from "./model-turn-result.ts";
import { unanswered } from "./stored-turn.ts";
import { TurnProgress } from "./turn-progress.ts";
import { stepLimitReason } from "./turn-record.ts";
import type { TurnSession } from "./turn-session.ts";

interface StepLimitFailure<Failure, Requirements> {
  readonly session: TurnSession;
  readonly kind: ModelTurnKind<Failure, Requirements>;
  readonly earlier: readonly ModelMessage[];
  readonly behavior: BehaviorConfig;
}

export const failAtStepLimit = Effect.fnUntraced(function* failAtStepLimit<
  Failure,
  Requirements,
>({
  session,
  kind,
  earlier,
  behavior,
}: StepLimitFailure<Failure, Requirements>) {
  const { eventId } = kind.event;
  yield* session.commit({
    eventId,
    turnContext: yield* (yield* TurnProgress).turnContextFor(eventId),
    inputs: kind.inputs,
    steps: earlier,
    ending: unanswered,
    trustLevel: kind.trustLevel,
  });
  return {
    _tag: "Failed",
    reason: stepLimitReason(behavior.maxToolSteps),
  } satisfies ModelTurnResult;
});
