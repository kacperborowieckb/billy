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
  | "RefusedBlockSkipped"
  | "StorageFailed";

const burstPollInterval = "250 millis";

type CompactionCall =
  | { readonly _tag: "Generated"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly cause: unknown }
  | { readonly _tag: "StoppedByBurst" };

type SummaryAttempts =
  | { readonly _tag: "Accepted"; readonly summary: string }
  | { readonly _tag: "Refused" }
  | Exclude<CompactionCall, { readonly _tag: "Generated" }>;

const summaryTargetsOf = (maxSummaryTokens: number) => [
  maxSummaryTokens,
  Math.floor(maxSummaryTokens / 2),
];

const summaryIsAccepted = (reply: ModelReply, maxSummaryTokens: number) =>
  reply.text.trim() !== "" &&
  !reply.reachedOutputLimit &&
  reply.usage.outputTokens !== undefined &&
  reply.usage.outputTokens <= maxSummaryTokens;

interface CompactionRequest {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly compactionId: string;
  readonly block: CompactionBlock;
}

interface SummaryRequest extends CompactionRequest {
  readonly summaryTarget: number;
}

const compactionCall = Effect.fnUntraced(function* compactionCall({
  ownerId,
  behavior,
  compactionId,
  block,
  summaryTarget,
}: SummaryRequest) {
  const gateway = yield* ModelGateway;
  const inbox = yield* Inbox;
  const system = compactionInstructions(summaryTarget);
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
      maxOutputTokens: behavior.maxSummaryTokens,
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

const summaryAttempts = Effect.fnUntraced(function* summaryAttempts(
  request: CompactionRequest
) {
  const inbox = yield* Inbox;
  const { maxSummaryTokens } = request.behavior;
  for (const summaryTarget of summaryTargetsOf(maxSummaryTokens)) {
    const call = yield* compactionCall({ ...request, summaryTarget });
    if (call._tag !== "Generated") {
      return call satisfies SummaryAttempts;
    }
    if (summaryIsAccepted(call.reply, maxSummaryTokens)) {
      return {
        _tag: "Accepted",
        summary: call.reply.text.trim(),
      } satisfies SummaryAttempts;
    }
    yield* Effect.logWarning("The Compaction Summary was refused", {
      summaryTarget,
      outputTokens: call.reply.usage.outputTokens,
      reachedOutputLimit: call.reply.reachedOutputLimit,
    });
    if (yield* inbox.burstIsDue(burstWaitOf(request.behavior))) {
      return { _tag: "StoppedByBurst" } satisfies SummaryAttempts;
    }
  }
  return { _tag: "Refused" } satisfies SummaryAttempts;
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
    const lastRefusedBlockEnd = yield* conversation.lastRefusedBlockEnd;
    if (
      Option.contains(lastRefusedBlockEnd, block.value.lastCompactedSequence)
    ) {
      return "RefusedBlockSkipped" satisfies CompactionResult;
    }
    const compactionId = `compaction-${crypto.randomUUID()}`;
    const attempts = yield* summaryAttempts({
      ownerId,
      behavior,
      compactionId,
      block: block.value,
    });
    if (attempts._tag === "StoppedByBurst") {
      return "StoppedByBurst" satisfies CompactionResult;
    }
    if (attempts._tag === "ModelFailed") {
      yield* Effect.logWarning(
        "The Compaction model call failed",
        attempts.cause
      );
      return "ModelFailed" satisfies CompactionResult;
    }
    if (attempts._tag === "Refused") {
      yield* conversation.recordRefusedBlock(block.value.lastCompactedSequence);
      return "SummaryRefused" satisfies CompactionResult;
    }
    if (yield* inbox.burstIsDue(burstWaitOf(behavior))) {
      return "StoppedByBurst" satisfies CompactionResult;
    }
    yield* conversation.replaceWithSummary({
      compactionId,
      lastCompactedSequence: block.value.lastCompactedSequence,
      message: summaryMessage(attempts.summary),
    });
    return "Compacted" satisfies CompactionResult;
  }
);
