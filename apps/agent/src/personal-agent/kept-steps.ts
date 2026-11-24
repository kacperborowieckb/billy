import type { ModelMessage } from "ai";
import { Effect, Option } from "effect";

import { Redactor } from "../tracing/redactor.ts";
import { withRecordedToolParts } from "./stored-turn.ts";
import { TurnProgress } from "./turn-progress.ts";

export const stepsNotKeptReason =
  "Turn progress did not keep the steps of the finished run";

interface FinishedSteps {
  readonly eventId: string;
  readonly earlier: readonly ModelMessage[];
  readonly turnMessages: readonly ModelMessage[];
}

export const keepFinishedSteps = Effect.fnUntraced(function* keepFinishedSteps({
  eventId,
  earlier,
  turnMessages,
}: FinishedSteps) {
  const progress = yield* TurnProgress;
  const redactor = yield* Redactor;
  const recorded = yield* progress.completedFor(eventId);
  return yield* progress
    .replaceSteps(eventId, [
      ...earlier,
      ...withRecordedToolParts(
        turnMessages.map((message) => redactor.redactMessage(message)),
        recorded
      ),
    ])
    .pipe(
      Effect.map(Option.some),
      Effect.tapCause((cause) => Effect.logWarning(stepsNotKeptReason, cause)),
      Effect.orElseSucceed(() => Option.none<readonly ModelMessage[]>())
    );
});
