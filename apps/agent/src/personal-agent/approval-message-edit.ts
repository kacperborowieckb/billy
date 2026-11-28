import { Data, DateTime, Duration, Effect, Option, Schedule } from "effect";

import { approvalPathLog } from "../approval/approval-log.ts";
import { shownStatusOf } from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import type { ShownApproval } from "../channels/channel.ts";

export const channelAnswerTimeoutMillis = 3000;

export const approvalEditAttempts = 3;

const approvalEditRetryDelay = Duration.millis(500);

class ApprovalEditFailed extends Data.TaggedError("ApprovalEditFailed")<{
  readonly reason: string;
}> {}

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
            ...(row.reviewerReason === null
              ? {}
              : { reviewerReason: row.reviewerReason }),
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
      yield* approvalPathLog({
        pendingApprovalId: target.pendingApprovalId,
        step: "message_has_nothing_to_edit",
      });
      return;
    }
    const { channelMessageId } = approval.value;
    const attemptEdit = Effect.fnUntraced(function* attemptEdit() {
      const turnApprovals = yield* pendingApprovals.forTurn(
        approval.value.turnEventId
      );
      const edited = yield* channel
        .editApprovalMessage({
          conversationId: target.conversationId,
          channelMessageId,
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
      return edited._tag === "Failed"
        ? yield* Effect.fail(new ApprovalEditFailed({ reason: edited.reason }))
        : edited;
    });
    const edited = yield* attemptEdit().pipe(
      Effect.retry({
        times: approvalEditAttempts - 1,
        schedule: Schedule.spaced(approvalEditRetryDelay),
      }),
      Effect.catchTag("ApprovalEditFailed", ({ reason }) =>
        Effect.succeed({ _tag: "Failed" as const, reason })
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
