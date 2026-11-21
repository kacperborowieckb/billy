import { DateTime, Effect, Option } from "effect";

import {
  conversationEntryOf,
  lateNoticeOf,
  statusOfApproval,
} from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type {
  ApprovalRunOutcome,
  PendingApproval,
} from "../approval/pending-approvals.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import {
  toolNamed,
  unexpectedToolFailureMessage,
} from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { Redactor } from "../tracing/redactor.ts";
import { AgentStorage } from "./agent-storage.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import type { Burst } from "./burst.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { ApprovalAnsweredEvent } from "./inbox.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";

export interface ApprovalAnswerSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

export const turnGoneReason = "The Turn of this Approval is no longer stored";

export const toolGoneReason = "The tool of this Approval no longer exists";

const burstOfTurn = Effect.fnUntraced(function* burstOfTurn(
  turnEventId: string
) {
  const journal = yield* Journal;
  const inbox = yield* Inbox;
  const linkedEventIds = (yield* journal.readOfKind("AnsweredByTurn")).flatMap(
    ({ record }) =>
      record._tag === "AnsweredByTurn" && record.turnEventId === turnEventId
        ? [record.eventId]
        : []
  );
  const events = yield* inbox.ownerMessagesWithIds([
    turnEventId,
    ...linkedEventIds,
  ]);
  const turnEvent = events.find((event) => event.eventId === turnEventId);
  return turnEvent === undefined
    ? Option.none<Burst>()
    : Option.some<Burst>([
        turnEvent,
        ...events.filter((event) => event !== turnEvent),
      ]);
});

const failedRun = (reason: string): ApprovalRunOutcome => ({
  result: "failed",
  reason,
});

const runApprovedCall = Effect.fnUntraced(function* runApprovedCall(
  { behavior, tools }: ApprovalAnswerSettings,
  approval: PendingApproval
) {
  const redactor = yield* Redactor;
  const burst = yield* burstOfTurn(approval.turnEventId);
  if (Option.isNone(burst)) {
    return failedRun(turnGoneReason);
  }
  const turnTools = {
    ...tools,
    ...ownerMessageTools(burst.value, {
      ...(yield* agentToolServices),
      behavior,
    }),
  };
  const tool = toolNamed(turnTools, approval.toolName);
  if (tool === undefined) {
    return failedRun(toolGoneReason);
  }
  return yield* tool
    .executeApproved(approval.frozenInput, approval.pendingApprovalId)
    .pipe(
      Effect.map((output): ApprovalRunOutcome => ({
        result: "executed",
        output,
      })),
      Effect.catchTag("ToolFailed", (failure) =>
        Effect.succeed(failedRun(redactor.redact(failure.message)))
      ),
      Effect.catchCause(() =>
        Effect.succeed(failedRun(unexpectedToolFailureMessage))
      )
    );
});

const answerAndRun = Effect.fnUntraced(function* answerAndRun(
  settings: ApprovalAnswerSettings,
  event: ApprovalAnsweredEvent,
  approval: PendingApproval
) {
  const pendingApprovals = yield* PendingApprovals;
  const conversation = yield* Conversation;
  const answering = {
    eventId: event.eventId,
    pendingApprovalId: approval.pendingApprovalId,
  };
  if (
    !(yield* pendingApprovals.answerPending({
      ...answering,
      answer: event.answer,
    }))
  ) {
    return;
  }
  if (event.answer === "approve") {
    yield* pendingApprovals.recordRun({
      ...answering,
      outcome: yield* runApprovedCall(settings, approval),
    });
  }
  const answered = yield* pendingApprovals.byId(approval.pendingApprovalId);
  const status = answered.pipe(
    Option.flatMap((row) => Option.fromNullishOr(statusOfApproval(row)))
  );
  if (Option.isSome(status)) {
    yield* conversation.append(event.eventId, [
      {
        role: "assistant",
        content: conversationEntryOf(approval.summary, status.value),
      },
    ]);
  }
});

const editApprovalMessage = Effect.fnUntraced(function* editApprovalMessage(
  event: ApprovalAnsweredEvent
) {
  const pendingApprovals = yield* PendingApprovals;
  const channel = yield* Channel;
  const approval = yield* pendingApprovals.byId(event.pendingApprovalId);
  if (Option.isNone(approval) || approval.value.channelMessageId === null) {
    return;
  }
  const turnApprovals = (yield* pendingApprovals.forTurn(
    approval.value.turnEventId
  )).flatMap((row) => {
    const status = statusOfApproval(row);
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
  const edited = yield* channel.editApprovalMessage({
    conversationId: event.conversationId,
    channelMessageId: approval.value.channelMessageId,
    turnApprovals,
  });
  if (edited._tag === "Failed") {
    yield* Effect.logWarning("The Approval message was not edited", {
      pendingApprovalId: event.pendingApprovalId,
      reason: edited.reason,
    });
  }
});

const answeredByEvent = Effect.fnUntraced(function* answeredByEvent(
  event: ApprovalAnsweredEvent
) {
  const journal = yield* Journal;
  return (yield* journal.readForEvent(event.eventId)).some(
    ({ record }) => record._tag === "ApprovalAnswered"
  );
});

const answerPress = Effect.fnUntraced(function* answerPress(
  settings: ApprovalAnswerSettings,
  event: ApprovalAnsweredEvent
) {
  const { database } = yield* AgentStorage;
  const pendingApprovals = yield* PendingApprovals;
  const channel = yield* Channel;
  const approval = yield* pendingApprovals.byId(event.pendingApprovalId);
  const notice = lateNoticeOf(approval, yield* DateTime.now);
  yield* channel.answerPress({
    pressId: event.pressId,
    ...(notice === undefined ? {} : { notice }),
  });
  if (notice !== undefined || Option.isNone(approval)) {
    return false;
  }
  yield* database.transaction(() =>
    answerAndRun(settings, event, approval.value)
  );
  return yield* answeredByEvent(event);
});

export const handleApprovalAnswered = Effect.fnUntraced(
  function* handleApprovalAnswered(
    settings: ApprovalAnswerSettings,
    event: ApprovalAnsweredEvent
  ) {
    const inbox = yield* Inbox;
    if (
      (yield* answeredByEvent(event)) ||
      (yield* answerPress(settings, event))
    ) {
      yield* editApprovalMessage(event);
    }
    yield* inbox.markDone([event]);
  }
);
