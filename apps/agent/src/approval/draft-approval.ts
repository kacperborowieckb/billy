import { DateTime, Duration, Effect, Option, Result } from "effect";

import { toolNamed } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ApprovalRequestedCall } from "../model-gateway/model-step.ts";
import type { TrustLevel } from "../notes/note.ts";
import { Redactor } from "../tracing/redactor.ts";
import { fitsOneApprovalRow } from "./approval-summary.ts";
import {
  isPendingApprovalId,
  pendingApprovalIdLength,
} from "./pending-approval-id.ts";
import { PendingApprovals } from "./pending-approvals.ts";
import type { DraftApproval } from "./pending-approvals.ts";

const waitingForApprovalOpening =
  "This call did not run. It waits for the Owner's Approval, id ";

export const waitingForApprovalOutput = (pendingApprovalId: string) =>
  `${waitingForApprovalOpening}${pendingApprovalId}. The Owner gets Approve and Reject buttons with your reply. Tell the Owner what waits for their Approval, and never say that it is done.`;

export const pendingApprovalIdOfOutput = (output: string) => {
  if (!output.startsWith(waitingForApprovalOpening)) {
    return;
  }
  const idStart = waitingForApprovalOpening.length;
  const id = output.slice(idStart, idStart + pendingApprovalIdLength);
  return isPendingApprovalId(id) ? id : undefined;
};

export const operatorSecretRefusal =
  "This call holds a secret of the Operator, so it cannot wait for the Owner's Approval, and it did not run. Tell the Owner that you could not do it.";

export const approvalUnavailableRefusal =
  "This call needs the Owner's Approval, which this Turn cannot ask for, so it did not run. Tell the Owner that you could not do it.";

export const summaryTooLongRefusal =
  "This call is too long to show to the Owner for Approval, so it did not run. Tell the Owner that you could not do it, and ask for a shorter request.";

export const noSummaryRefusal =
  "This call cannot be shown to the Owner for Approval, so it did not run. Tell the Owner that you could not do it.";

export type DraftOutcome =
  | { readonly _tag: "Drafted"; readonly draft: DraftApproval }
  | { readonly _tag: "Refused"; readonly reason: string };

export interface ApprovalDrafting {
  readonly turnEventId: string;
  readonly trustLevel: TrustLevel;
  readonly tools: AgentTools;
  readonly expiryMillis: number;
}

const refused = (reason: string): DraftOutcome => ({ _tag: "Refused", reason });

export const holdsOperatorSecret = (
  redactor: Redactor["Service"],
  value: unknown
): boolean => {
  if (typeof value === "string") {
    return redactor.redact(value) !== value;
  }
  if (Array.isArray(value)) {
    return value.some((item) => holdsOperatorSecret(redactor, item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) =>
        holdsOperatorSecret(redactor, key) ||
        holdsOperatorSecret(redactor, item)
    );
  }
  return false;
};

export const draftApproval = Effect.fnUntraced(function* draftApproval(
  { turnEventId, trustLevel, tools, expiryMillis }: ApprovalDrafting,
  call: ApprovalRequestedCall
) {
  const redactor = yield* Redactor;
  const pendingApprovals = yield* PendingApprovals;
  const tool = toolNamed(tools, call.name);
  if (tool === undefined) {
    return refused(noSummaryRefusal);
  }
  if (holdsOperatorSecret(redactor, call.input)) {
    return refused(operatorSecretRefusal);
  }
  const summary = yield* tool.approvalSummaryOf(call.input).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(({ message }) => message),
    Effect.result
  );
  if (Result.isFailure(summary)) {
    return refused(summary.failure);
  }
  if (summary.success === undefined) {
    return refused(noSummaryRefusal);
  }
  const shownSummary = redactor.redact(summary.success);
  if (!fitsOneApprovalRow(shownSummary)) {
    return refused(summaryTooLongRefusal);
  }
  const now = yield* DateTime.now;
  const draft = yield* pendingApprovals.draft({
    turnEventId,
    toolCallId: call.callId,
    toolName: call.name,
    frozenInput: call.input,
    summary: shownSummary,
    reviewerReason: call.reviewerReason,
    trustLevel,
    expiresAt: DateTime.addDuration(
      now,
      Duration.millis(tool.approvalExpiryMillis ?? expiryMillis)
    ),
  });
  return { _tag: "Drafted", draft } satisfies DraftOutcome;
});
