import { DateTime, Effect, Option } from "effect";

import { lateNoticeOf } from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import { Redactor } from "../tracing/redactor.ts";
import { channelAnswerTimeoutMillis } from "./approval-message-edit.ts";

export interface ApprovalDetailsPress {
  readonly pressId: string;
  readonly conversationId: string;
  readonly pendingApprovalId: string;
}

export const detailsFilenameOf = (pendingApprovalId: string) =>
  `approval-${pendingApprovalId}.txt`;

export const showApprovalDetails = Effect.fnUntraced(
  function* showApprovalDetails(press: ApprovalDetailsPress) {
    const pendingApprovals = yield* PendingApprovals;
    const channel = yield* Channel;
    const redactor = yield* Redactor;
    const approval = yield* pendingApprovals.byId(press.pendingApprovalId);
    const notice = lateNoticeOf(approval, yield* DateTime.now);
    yield* channel
      .answerPress({
        pressId: press.pressId,
        ...(notice === undefined ? {} : { notice }),
      })
      .pipe(Effect.timeoutOption(channelAnswerTimeoutMillis));
    if (notice !== undefined || Option.isNone(approval)) {
      return;
    }
    yield* channel.sendDocument({
      conversationId: press.conversationId,
      filename: detailsFilenameOf(press.pendingApprovalId),
      text: redactor.redact(
        JSON.stringify(approval.value.frozenInput, null, 2)
      ),
    });
  }
);
