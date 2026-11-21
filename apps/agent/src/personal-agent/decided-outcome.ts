import type { DraftApproval } from "../approval/pending-approvals.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import type { OutcomeKind } from "./storage-values.ts";
import type {
  ModelFailure,
  ModelOutcome,
  ReactionOutcome,
} from "./turn-record.ts";

export interface DecidedOutcome {
  readonly outcome: ModelOutcome;
  readonly kind: OutcomeKind | undefined;
  readonly reaction?: ReactionOutcome;
  readonly refusedOutcomeTools: readonly string[];
  readonly drafts: readonly DraftApproval[];
  readonly stoppedAfterDrafts?: ModelFailure;
}

type TurnSoFar = Pick<DecidedOutcome, "refusedOutcomeTools" | "drafts">;

export const withEarlierSteps = (
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

export const approvalsWithoutModelText = (
  reply: ModelReply,
  stopped: ModelFailure,
  soFar: TurnSoFar
): DecidedOutcome => ({
  outcome: {
    _tag: "Replied",
    reply: {
      ...reply,
      text: "",
      steps: stopped.steps,
      usage: sumUsage(stopped.steps.map((step) => step.usage)),
    },
  },
  kind: "reply",
  stoppedAfterDrafts: stopped,
  ...soFar,
});

export const stepLimitReachedIn = (
  reply: ModelReply,
  steps: readonly ModelStep[],
  stepLimit: number
) =>
  new StepLimitReached({
    modelId: reply.modelId,
    reasoningEffort: reply.reasoningEffort,
    stepLimit,
    steps,
  });

export const modelFailed = (
  error: ModelFailure,
  soFar: TurnSoFar
): DecidedOutcome => ({
  outcome: { _tag: "ModelFailed", error },
  kind: undefined,
  ...soFar,
});
