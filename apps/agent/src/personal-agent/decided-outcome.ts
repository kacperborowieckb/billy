import type { DraftApproval } from "../approval/pending-approvals.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import type { OutcomeKind } from "./storage-values.ts";
import { holdsOnlyStubs, withoutReplyText } from "./stub-reply.ts";
import type {
  ModelFailure,
  ModelOutcome,
  ReactionOutcome,
} from "./turn-record.ts";

export interface OutcomeRecords {
  readonly refusedOutcomeTools: string[];
  readonly rejectedStubReplies: string[];
  readonly drafts: DraftApproval[];
}

export interface DecidedOutcome extends Readonly<OutcomeRecords> {
  readonly outcome: ModelOutcome;
  readonly kind: OutcomeKind | undefined;
  readonly reaction?: ReactionOutcome;
}

const withEarlierSteps = (
  error: ModelFailure,
  earlier: readonly ModelStep[]
): ModelFailure =>
  error._tag === "StepLimitReached"
    ? new StepLimitReached({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        stepLimit: error.stepLimit,
        steps: [...earlier, ...error.steps],
      })
    : new ModelUnavailable({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        cause: error.cause,
        steps: [...earlier, ...error.steps],
      });

const failedWith = (
  records: OutcomeRecords,
  error: ModelFailure
): DecidedOutcome => ({
  outcome: { _tag: "ModelFailed", error },
  kind: undefined,
  ...records,
});

export const failedModelCall = (
  records: OutcomeRecords,
  error: ModelFailure,
  earlier: readonly ModelStep[]
) => failedWith(records, withEarlierSteps(error, earlier));

interface EndedGeneration {
  readonly reply: ModelReply;
  readonly steps: readonly ModelStep[];
}

export const reachedStepLimit = (
  records: OutcomeRecords,
  { reply, steps }: EndedGeneration,
  stepLimit: number
) =>
  failedWith(
    records,
    new StepLimitReached({
      modelId: reply.modelId,
      reasoningEffort: reply.reasoningEffort,
      stepLimit,
      steps,
    })
  );

export const unusableReply = (
  records: OutcomeRecords,
  { reply, steps }: EndedGeneration,
  reason: string
) =>
  failedWith(
    records,
    new ModelUnavailable({
      modelId: reply.modelId,
      reasoningEffort: reply.reasoningEffort,
      cause: new Error(reason),
      steps,
    })
  );

interface Decision extends EndedGeneration {
  readonly kind: OutcomeKind;
  readonly reaction?: ReactionOutcome | undefined;
}

export const repliedWith = (
  records: OutcomeRecords,
  { reply, steps, kind, reaction }: Decision
): DecidedOutcome => ({
  outcome: {
    _tag: "Replied",
    reply: {
      ...reply,
      steps,
      usage: sumUsage(steps.map((step) => step.usage)),
    },
  },
  kind,
  ...(reaction === undefined ? {} : { reaction }),
  ...records,
});

export const stoppedReply = (
  records: OutcomeRecords,
  { reply, steps }: EndedGeneration
) => {
  if (!holdsOnlyStubs(reply.text)) {
    return repliedWith(records, { reply, steps, kind: "reply" });
  }
  records.rejectedStubReplies.push(reply.text);
  return repliedWith(records, {
    reply: { ...reply, text: "" },
    steps: withoutReplyText(steps),
    kind: "reply",
  });
};
