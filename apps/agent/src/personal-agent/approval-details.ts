import { Effect, Option } from "effect";

import { alreadyAnsweredNotice } from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import { Redactor } from "../tracing/redactor.ts";
import { channelAnswerTimeoutMillis } from "./approval-message-edit.ts";

export interface ApprovalDetailsPress {
  readonly pressId: string;
  readonly conversationId: string;
  readonly pendingApprovalId: string;
}

export const detailsNotSentText =
  "The details could not be sent. Tap Details again to retry.";

export const detailsFilenameOf = (pendingApprovalId: string) =>
  `approval-${pendingApprovalId}.txt`;

export const showApprovalDetails = Effect.fnUntraced(
  function* showApprovalDetails(press: ApprovalDetailsPress) {
    const pendingApprovals = yield* PendingApprovals;
    const channel = yield* Channel;
    const redactor = yield* Redactor;
    const approval = yield* pendingApprovals.byId(press.pendingApprovalId);
    yield* channel
      .answerPress({
        pressId: press.pressId,
        ...(Option.isNone(approval) ? { notice: alreadyAnsweredNotice } : {}),
      })
      .pipe(Effect.timeoutOption(channelAnswerTimeoutMillis));
    if (Option.isNone(approval)) {
      return;
    }
    const delivery = yield* channel.sendDocument({
      conversationId: press.conversationId,
      filename: detailsFilenameOf(press.pendingApprovalId),
      text: redactor.redact(
        JSON.stringify(approval.value.frozenInput, null, 2)
      ),
    });
    if (delivery._tag === "Failed") {
      yield* channel.send({
        conversationId: press.conversationId,
        text: detailsNotSentText,
      });
    }
  }
);
