import { Effect } from "effect";

import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { DraftApproval } from "../approval/pending-approvals.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { ApprovalRequest } from "../channels/channel.ts";
import type { ApprovalAsking } from "./approval-step.ts";
import { react } from "./delivery-reaction.ts";
import { sendWithApprovals } from "./delivery-send.ts";
import { send } from "./delivery.ts";
import type { InboxEvent } from "./inbox.ts";
import type { ReactionOutcome } from "./turn-record.ts";

export const approvalAskingOf = (
  behavior: BehaviorConfig,
  asksOwnerForApproval: boolean | undefined
): ApprovalAsking =>
  asksOwnerForApproval === true
    ? { _tag: "AskOwner", expiryMillis: behavior.pendingApprovalExpiryMillis }
    : { _tag: "Unavailable" };

const approvalRequestsOf = (
  drafts: readonly DraftApproval[]
): readonly [ApprovalRequest, ...ApprovalRequest[]] | undefined => {
  const [first, ...rest] = drafts.map(({ pendingApprovalId, summary }) => ({
    pendingApprovalId,
    summary,
  }));
  return first === undefined ? undefined : [first, ...rest];
};

interface TurnOutcomeDelivery {
  readonly event: InboxEvent;
  readonly text: string;
  readonly drafts: readonly DraftApproval[];
  readonly reaction: ReactionOutcome | undefined;
  readonly replyTo: InboxEvent;
}

const sendWithDrafts = Effect.fnUntraced(function* sendWithDrafts(
  { event, text, replyTo }: TurnOutcomeDelivery,
  approvals: readonly [ApprovalRequest, ...ApprovalRequest[]]
) {
  const pendingApprovals = yield* PendingApprovals;
  const delivery = yield* sendWithApprovals({
    event,
    text,
    approvals,
    replyTo,
  });
  yield* delivery._tag === "Confirmed"
    ? pendingApprovals.openDrafts({
        turnEventId: event.eventId,
        approvalMessages: delivery.approvalMessages,
      })
    : pendingApprovals.dropDrafts(event.eventId);
  return delivery;
});

export const deliverTurnOutcome = (outcome: TurnOutcomeDelivery) => {
  const approvals = approvalRequestsOf(outcome.drafts);
  if (approvals !== undefined) {
    return sendWithDrafts(outcome, approvals);
  }
  const { event, text, reaction, replyTo } = outcome;
  return reaction === undefined
    ? send(event, text, replyTo)
    : react(event, reaction.emoji, replyTo);
};
