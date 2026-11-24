import { Effect, Option, Schedule } from "effect";

import { fixedTurnTrust } from "../approval/turn-trust.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import { UsageLedger } from "../model-gateway/usage-ledger.ts";
import { burstWaitOf } from "./burst-wait.ts";
import {
  compactionBlockOf,
  historyTokensOverLimit,
} from "./compaction-block.ts";
import type { CompactionBlock } from "./compaction-block.ts";
import {
  compactionInput,
  compactionInstructions,
  summaryMessage,
} from "./compaction-prompt.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";

export type CompactionResult =
  | "NotNeeded"
  | "Compacted"
  | "StoppedByBurst"
  | "ModelFailed"
  | "SummaryRefused";

const burstPollInterval = "250 millis";

type CompactionCall =
  | { readonly _tag: "Generated"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly cause: unknown }
  | { readonly _tag: "StoppedByBurst" };

const summaryIsAccepted = (reply: ModelReply, maxSummaryTokens: number) =>
  reply.text.trim() !== "" &&
  reply.usage.outputTokens !== undefined &&
  reply.usage.outputTokens <= maxSummaryTokens;

const compactionCall = Effect.fnUntraced(function* compactionCall(
  behavior: BehaviorConfig,
  compactionId: string,
  block: CompactionBlock
) {
  const gateway = yield* ModelGateway;
  const inbox = yield* Inbox;
  const generated = gateway
    .generate({
      task: "compaction",
      eventId: compactionId,
      system: compactionInstructions(behavior.maxSummaryTokens),
      messages: [compactionInput(block)],
      trust: fixedTurnTrust("owner"),
      stepLimit: 1,
    })
    .pipe(
      Effect.map((reply): CompactionCall => ({ _tag: "Generated", reply })),
      Effect.catchTags({
        ModelUnavailable: (error) =>
          Effect.succeed<CompactionCall>({
            _tag: "ModelFailed",
            cause: error.cause,
          }),
        StepLimitReached: (error) =>
          Effect.succeed<CompactionCall>({
            _tag: "ModelFailed",
            cause: error,
          }),
      })
    );
  const burstBecameDue = inbox.burstIsDue(burstWaitOf(behavior)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(burstPollInterval),
      until: (due) => due,
    }),
    Effect.as<CompactionCall>({ _tag: "StoppedByBurst" })
  );
  return yield* Effect.raceFirst(generated, burstBecameDue);
});

export const compactWhenOverLimit = Effect.fnUntraced(
  function* compactWhenOverLimit(behavior: BehaviorConfig) {
    const conversation = yield* Conversation;
    const ledger = yield* UsageLedger;
    const inbox = yield* Inbox;
    const steps = yield* ledger.stepsAfterEvent(
      "reply",
      yield* conversation.summaryEventId
    );
    const historyTokens = historyTokensOverLimit(steps, behavior);
    if (Option.isNone(historyTokens)) {
      return "NotNeeded" satisfies CompactionResult;
    }
    const block = compactionBlockOf(
      {
        rows: yield* conversation.uncompactedRows,
        stepsSinceSummary: steps,
        historyTokens: historyTokens.value,
      },
      behavior
    );
    if (Option.isNone(block)) {
      return "NotNeeded" satisfies CompactionResult;
    }
    const compactionId = `compaction-${crypto.randomUUID()}`;
    const call = yield* compactionCall(behavior, compactionId, block.value);
    if (call._tag === "StoppedByBurst") {
      return "StoppedByBurst" satisfies CompactionResult;
    }
    if (call._tag === "ModelFailed") {
      yield* Effect.logWarning("The Compaction model call failed", call.cause);
      return "ModelFailed" satisfies CompactionResult;
    }
    if (!summaryIsAccepted(call.reply, behavior.maxSummaryTokens)) {
      yield* Effect.logWarning(
        "The Compaction Summary was refused",
        call.reply.usage.outputTokens
      );
      return "SummaryRefused" satisfies CompactionResult;
    }
    if (yield* inbox.burstIsDue(burstWaitOf(behavior))) {
      return "StoppedByBurst" satisfies CompactionResult;
    }
    yield* conversation.replaceWithSummary({
      compactionId,
      lastCompactedSequence: block.value.lastCompactedSequence,
      message: summaryMessage(call.reply.text.trim()),
    });
    return "Compacted" satisfies CompactionResult;
  }
);
