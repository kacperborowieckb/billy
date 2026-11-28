import type { DraftApproval } from "../approval/pending-approvals.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { ModelUnavailable } from "../model-gateway/model-unavailable.ts";

export const noTextForNeededReplyReason =
  "The model sent no text for a Turn that must answer with text";

interface ReplyEnd {
  readonly textReplyNeeded: boolean;
  readonly drafts: readonly DraftApproval[];
  readonly text: string;
}

export const missesNeededText = ({ textReplyNeeded, drafts, text }: ReplyEnd) =>
  textReplyNeeded && drafts.length === 0 && text.trim().length === 0;

export const unusableReplyFailure = (
  reply: Pick<ModelReply, "modelId" | "reasoningEffort">,
  reason: string,
  steps: readonly ModelStep[]
) =>
  new ModelUnavailable({
    modelId: reply.modelId,
    reasoningEffort: reply.reasoningEffort,
    cause: new Error(reason),
    steps,
  });
