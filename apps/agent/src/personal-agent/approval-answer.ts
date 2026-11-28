import { DateTime, Effect, Option } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import { approvalPathLog } from "../approval/approval-log.ts";
import {
  conversationEntryOf,
  lateNoticeOf,
  statusOfApproval,
} from "../approval/approval-status.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { toolNamed } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "./agent-storage.ts";
import {
  channelAnswerTimeoutMillis,
  editApprovalMessage,
} from "./approval-message-edit.ts";
import {
  answerWithApprovalResult,
  approvalRunOf,
  recordApprovedCallSteps,
} from "./approval-result-turn.ts";
import { runApprovedCall, turnToolsOf } from "./approved-call.ts";
import type { ApprovalAnswerSettings } from "./approved-call.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { ApprovalAnsweredEvent } from "./inbox.ts";

const appendApprovalStatus = Effect.fnUntraced(function* appendApprovalStatus(
  eventId: string,
  approval: PendingApproval
) {
  const pendingApprovals = yield* PendingApprovals;
  const conversation = yield* Conversation;
  const answered = yield* pendingApprovals.byId(approval.pendingApprovalId);
  const status = answered.pipe(
    Option.flatMap((row) => Option.fromNullishOr(statusOfApproval(row)))
  );
  if (Option.isSome(status)) {
    yield* conversation.append({
      eventId,
      recordedAs: `${eventId}:approval-status`,
      rows: [
        {
          kind: "approval_status",
          message: {
            role: "assistant",
            content: conversationEntryOf(approval, status.value),
          },
          trustLevel: "owner",
        },
      ],
    });
  }
});

const answerPending = Effect.fnUntraced(function* answerPending(
  event: ApprovalAnsweredEvent,
  approval: PendingApproval
) {
  const pendingApprovals = yield* PendingApprovals;
  return yield* pendingApprovals.answerPending({
    eventId: event.eventId,
    pendingApprovalId: approval.pendingApprovalId,
    answer: event.answer,
  });
});

const recordRunAndStatus = Effect.fnUntraced(function* recordRunAndStatus(
  eventId: string,
  approval: PendingApproval,
  outcome: ApprovalRunOutcome
) {
  const pendingApprovals = yield* PendingApprovals;
  yield* pendingApprovals.recordRun({
    eventId,
    pendingApprovalId: approval.pendingApprovalId,
    outcome,
  });
  yield* recordApprovedCallSteps(eventId, approval, outcome);
  yield* appendApprovalStatus(eventId, approval);
});

const answerAndRunInOneTransaction = Effect.fnUntraced(
  function* answerAndRunInOneTransaction(
    settings: ApprovalAnswerSettings,
    event: ApprovalAnsweredEvent,
    approval: PendingApproval
  ) {
    if (!(yield* answerPending(event, approval))) {
      yield* approvalPathLog({
        pendingApprovalId: approval.pendingApprovalId,
        step: "answer_lost_to_another_press",
      });
      return;
    }
    if (event.answer === "approve") {
      yield* recordRunAndStatus(
        event.eventId,
        approval,
        yield* runApprovedCall(settings, approval)
      );
      return;
    }
    yield* appendApprovalStatus(event.eventId, approval);
  }
);

const hasExternalEffect = Effect.fnUntraced(function* hasExternalEffect(
  settings: ApprovalAnswerSettings,
  approval: PendingApproval
) {
  const turnTools = yield* turnToolsOf(settings, approval);
  return (
    Option.isSome(turnTools) &&
    toolNamed(turnTools.value, approval.toolName)?.hasExternalEffect === true
  );
});

const answerThenRunOutsideTransaction = Effect.fnUntraced(
  function* answerThenRunOutsideTransaction(
    settings: ApprovalAnswerSettings,
    event: ApprovalAnsweredEvent,
    approval: PendingApproval
  ) {
    const { database } = yield* AgentStorage;
    const answered = yield* database.transaction(() =>
      answerPending(event, approval)
    );
    if (!answered) {
      yield* approvalPathLog({
        pendingApprovalId: approval.pendingApprovalId,
        step: "answer_lost_to_another_press",
      });
      return;
    }
    const startedAt = yield* DateTime.now;
    const outcome = yield* runApprovedCall(settings, approval);
    yield* approvalPathLog({
      pendingApprovalId: approval.pendingApprovalId,
      step: "run_finished",
      toolName: approval.toolName,
      result: outcome.result,
      durationMillis:
        DateTime.toEpochMillis(yield* DateTime.now) -
        DateTime.toEpochMillis(startedAt),
    });
    yield* database.transaction(() =>
      recordRunAndStatus(event.eventId, approval, outcome)
    );
  }
);

const answerAndRun = Effect.fnUntraced(function* answerAndRun(
  settings: ApprovalAnswerSettings,
  event: ApprovalAnsweredEvent,
  approval: PendingApproval
) {
  const { database } = yield* AgentStorage;
  if (
    event.answer === "approve" &&
    (yield* hasExternalEffect(settings, approval))
  ) {
    return yield* answerThenRunOutsideTransaction(settings, event, approval);
  }
  return yield* database.transaction(() =>
    answerAndRunInOneTransaction(settings, event, approval)
  );
});

const settleLostRun = Effect.fnUntraced(function* settleLostRun(
  event: ApprovalAnsweredEvent
) {
  const { database } = yield* AgentStorage;
  const pendingApprovals = yield* PendingApprovals;
  const approval = yield* pendingApprovals.byId(event.pendingApprovalId);
  if (Option.isSome(approval) && approval.value.state === "approved") {
    yield* approvalPathLog({
      pendingApprovalId: event.pendingApprovalId,
      step: "lost_run_set_unconfirmed",
    });
    yield* database.transaction(() =>
      recordRunAndStatus(event.eventId, approval.value, {
        result: "unconfirmed",
      })
    );
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
  const pendingApprovals = yield* PendingApprovals;
  const channel = yield* Channel;
  const approval = yield* pendingApprovals.byId(event.pendingApprovalId);
  const notice = lateNoticeOf(approval, yield* DateTime.now);
  const pressAnswered = yield* channel
    .answerPress({
      pressId: event.pressId,
      ...(notice === undefined ? {} : { notice }),
    })
    .pipe(Effect.timeoutOption(channelAnswerTimeoutMillis));
  if (Option.isNone(pressAnswered)) {
    yield* Effect.logWarning("Telegram did not answer the press in time", {
      pendingApprovalId: event.pendingApprovalId,
    });
  }
  if (notice !== undefined || Option.isNone(approval)) {
    yield* approvalPathLog({
      pendingApprovalId: event.pendingApprovalId,
      step: "press_found_no_open_approval",
    });
    return false;
  }
  yield* answerAndRun(settings, event, approval.value);
  return yield* answeredByEvent(event);
});

export const handleApprovalAnswered = Effect.fnUntraced(
  function* handleApprovalAnswered(
    ownerId: OwnerId,
    settings: ApprovalAnswerSettings,
    event: ApprovalAnsweredEvent
  ) {
    const inbox = yield* Inbox;
    const alreadyAnswered = yield* answeredByEvent(event);
    if (alreadyAnswered) {
      yield* settleLostRun(event);
    }
    const answered = alreadyAnswered || (yield* answerPress(settings, event));
    if (answered) {
      yield* editApprovalMessage({
        conversationId: event.conversationId,
        pendingApprovalId: event.pendingApprovalId,
      });
    }
    const ran = yield* approvalRunOf(event, answered);
    if (Option.isNone(ran)) {
      yield* inbox.markDone([event]);
      return;
    }
    yield* answerWithApprovalResult({
      ownerId,
      settings,
      event,
      approval: ran.value,
    });
  }
);
