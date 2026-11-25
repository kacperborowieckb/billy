import { Effect, Option, Schedule } from "effect";

import { fixedTurnTrust } from "../approval/turn-trust.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import { UsageLedger } from "../model-gateway/usage-ledger.ts";
import type { OwnerId } from "../owner-id.ts";
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
import { recordCompactionSteps } from "./model-step-metrics.ts";

export type CompactionResult =
  | "NotNeeded"
  | "Compacted"
  | "StoppedByBurst"
  | "ModelFailed"
  | "SummaryRefused"
  | "StorageFailed";

const burstPollInterval = "250 millis";

type CompactionCall =
  | { readonly _tag: "Generated"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly cause: unknown }
  | { readonly _tag: "StoppedByBurst" };

const summaryIsAccepted = (reply: ModelReply, maxSummaryTokens: number) =>
  reply.text.trim() !== "" &&
  reply.usage.outputTokens !== undefined &&
  reply.usage.outputTokens <= maxSummaryTokens;

interface CompactionRequest {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly compactionId: string;
  readonly block: CompactionBlock;
}

const compactionCall = Effect.fnUntraced(function* compactionCall({
  ownerId,
  behavior,
  compactionId,
  block,
}: CompactionRequest) {
  const gateway = yield* ModelGateway;
  const inbox = yield* Inbox;
  const system = compactionInstructions(behavior.maxSummaryTokens);
  const recordSteps = (
    reply: Parameters<typeof recordCompactionSteps>[0]["reply"]
  ) => recordCompactionSteps({ ownerId, compactionId, system, reply });
  const generated = gateway
    .generate({
      task: "compaction",
      eventId: compactionId,
      system,
      messages: [compactionInput(block)],
      trust: fixedTurnTrust("owner"),
      asksOwnerForApproval: false,
      stepLimit: 1,
    })
    .pipe(
      Effect.tap(recordSteps),
      Effect.map((reply): CompactionCall => ({ _tag: "Generated", reply })),
      Effect.catchTags({
        ModelUnavailable: (error) =>
          recordSteps(error).pipe(
            Effect.as<CompactionCall>({
              _tag: "ModelFailed",
              cause: error.cause,
            })
          ),
        StepLimitReached: (error) =>
          recordSteps(error).pipe(
            Effect.as<CompactionCall>({ _tag: "ModelFailed", cause: error })
          ),
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
  function* compactWhenOverLimit(ownerId: OwnerId, behavior: BehaviorConfig) {
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
    const call = yield* compactionCall({
      ownerId,
      behavior,
      compactionId,
      block: block.value,
    });
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
