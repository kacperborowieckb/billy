import { Effect } from "effect";

import {
  approvalUnavailableRefusal,
  draftApproval,
} from "../approval/draft-approval.ts";
import type { DraftOutcome } from "../approval/draft-approval.ts";
import type { DraftApproval } from "../approval/pending-approvals.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ApprovalRequestedCall } from "../model-gateway/model-step.ts";
import type { TrustLevel } from "../notes/note.ts";
import { approvalResultOf } from "./step-closing.ts";
import type { ClosingResult } from "./step-closing.ts";

export type ApprovalAsking =
  | { readonly _tag: "AskOwner"; readonly expiryMillis: number }
  | { readonly _tag: "Unavailable" };

interface ApprovalStep {
  readonly asking: ApprovalAsking;
  readonly turnEventId: string;
  readonly trustLevel: TrustLevel;
  readonly tools: AgentTools;
}

const draftOrRefusal = (
  { asking, turnEventId, trustLevel, tools }: ApprovalStep,
  call: ApprovalRequestedCall
) =>
  asking._tag === "AskOwner"
    ? draftApproval(
        { turnEventId, trustLevel, tools, expiryMillis: asking.expiryMillis },
        call
      )
    : Effect.succeed<DraftOutcome>({
        _tag: "Refused",
        reason: approvalUnavailableRefusal,
      });

export const answerApprovalRequests = Effect.fnUntraced(
  function* answerApprovalRequests(
    step: ApprovalStep,
    calls: readonly ApprovalRequestedCall[]
  ) {
    const drafts: DraftApproval[] = [];
    const results: ClosingResult[] = [];
    for (const call of calls) {
      const drafted = yield* draftOrRefusal(step, call);
      if (drafted._tag === "Drafted") {
        drafts.push(drafted.draft);
      }
      results.push(approvalResultOf(call, drafted));
    }
    return { drafts, results };
  }
);
