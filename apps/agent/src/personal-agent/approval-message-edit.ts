import { DateTime, Effect, Option } from "effect";

import { shownStatusOf } from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import type { ShownApproval } from "../channels/channel.ts";

export const channelAnswerTimeoutMillis = 3000;

export interface ApprovalMessageTarget {
  readonly conversationId: string;
  readonly pendingApprovalId: string;
}

const shownApprovalsOf = (
  turnApprovals: readonly PendingApproval[],
  now: DateTime.Utc
): readonly ShownApproval[] =>
  turnApprovals.flatMap((row) => {
    const status = shownStatusOf(row, now);
    return row.channelMessageId === null
      ? []
      : [
          {
            pendingApprovalId: row.pendingApprovalId,
            summary: row.summary,
            channelMessageId: row.channelMessageId,
            ...(status === undefined ? {} : { status }),
          },
        ];
  });

export const editApprovalMessage = Effect.fnUntraced(
  function* editApprovalMessage(target: ApprovalMessageTarget) {
    const pendingApprovals = yield* PendingApprovals;
    const channel = yield* Channel;
    const approval = yield* pendingApprovals.byId(target.pendingApprovalId);
    if (Option.isNone(approval) || approval.value.channelMessageId === null) {
      return;
    }
    const turnApprovals = yield* pendingApprovals.forTurn(
      approval.value.turnEventId
    );
    const edited = yield* channel
      .editApprovalMessage({
        conversationId: target.conversationId,
        channelMessageId: approval.value.channelMessageId,
        turnApprovals: shownApprovalsOf(turnApprovals, yield* DateTime.now),
      })
      .pipe(
        Effect.timeoutOption(channelAnswerTimeoutMillis),
        Effect.map(
          Option.getOrElse(() => ({
            _tag: "Failed" as const,
            reason: "Telegram did not answer the edit in time",
          }))
        )
      );
    if (edited._tag === "Failed") {
      yield* Effect.logWarning("The Approval message was not edited", {
        pendingApprovalId: target.pendingApprovalId,
        reason: edited.reason,
      });
    }
  }
);
