import type { JSONValue, ModelMessage, ToolResultPart } from "ai";
import { Effect, Option } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import { approvalPathLog } from "../approval/approval-log.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import { markUntrustedContent } from "../notes/note.ts";
import type { OwnerId } from "../owner-id.ts";
import { Redactor } from "../tracing/redactor.ts";
import { whileAcknowledging } from "./acknowledge.ts";
import { toolsOfTurn } from "./approved-call.ts";
import type { ApprovalAnswerSettings } from "./approved-call.ts";
import { fail, failWithNotice, honestFailureText } from "./delivery.ts";
import { Inbox } from "./inbox.ts";
import type { ApprovalAnsweredEvent } from "./inbox.ts";
import type { ModelTurnResult } from "./model-turn-result.ts";
import { runModelTurn } from "./model-turn.ts";
import { openApprovalsSection } from "./open-approvals-section.ts";
import { reactSection } from "./react-tool.ts";
import { unconfirmedToolMessage } from "./recorded-tool.ts";
import { staySilentSection } from "./stay-silent-tool.ts";
import { storedToolNameOf } from "./tool-steps.ts";
import { TurnProgress } from "./turn-progress.ts";
import { traceOf } from "./turn-record.ts";
import { settleFromJournal } from "./turn-recovery.ts";
import { mainConversation } from "./turn-session.ts";

const ranOnApproval: ReadonlySet<PendingApproval["state"]> = new Set([
  "executed",
  "failed",
  "unconfirmed",
]);

export const failedApprovedCallMessage = (reason: string) =>
  `The approved call failed: ${reason}. Tell the Owner that it failed, and never say that it is done.`;

const outputOfRun = (outcome: ApprovalRunOutcome): ToolResultPart["output"] => {
  switch (outcome.result) {
    case "executed": {
      return { type: "json", value: outcome.output as JSONValue };
    }
    case "failed": {
      return {
        type: "error-text",
        value: failedApprovedCallMessage(outcome.reason),
      };
    }
    case "unconfirmed": {
      return { type: "error-text", value: unconfirmedToolMessage };
    }
    default: {
      return outcome satisfies never;
    }
  }
};

export const approvedCallSteps = (
  {
    pendingApprovalId,
    toolName,
    frozenInput,
  }: Pick<PendingApproval, "pendingApprovalId" | "toolName" | "frozenInput">,
  outcome: ApprovalRunOutcome
): readonly ModelMessage[] => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: pendingApprovalId,
        toolName,
        input: frozenInput,
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: pendingApprovalId,
        toolName,
        output: outputOfRun(outcome),
      },
    ],
  },
];

export const recordApprovedCallSteps = Effect.fnUntraced(
  function* recordApprovedCallSteps(
    eventId: string,
    approval: PendingApproval,
    outcome: ApprovalRunOutcome
  ) {
    const progress = yield* TurnProgress;
    const redactor = yield* Redactor;
    yield* progress.recordSteps(
      eventId,
      approvedCallSteps(approval, outcome).map((message) =>
        redactor.redactMessage(message)
      )
    );
  }
);

const summaryForModel = ({
  summary,
  trustLevel,
}: Pick<PendingApproval, "summary" | "trustLevel">) =>
  trustLevel === "untrusted" ? markUntrustedContent(summary) : summary;

export const approvalResultInput = (
  approval: Pick<
    PendingApproval,
    "pendingApprovalId" | "toolName" | "summary" | "trustLevel"
  >
): ModelMessage => ({
  role: "user",
  content: [
    `The Owner approved Approval ${approval.pendingApprovalId} (${storedToolNameOf(approval.toolName)}):`,
    summaryForModel(approval),
    "Code ran the approved call once. The call and its outcome follow. Tell the Owner what happened, from that outcome only.",
  ].join("\n"),
});

export const approvalRunOf = Effect.fnUntraced(function* approvalRunOf(
  event: ApprovalAnsweredEvent,
  answeredByEvent: boolean
) {
  const pendingApprovals = yield* PendingApprovals;
  if (!answeredByEvent || event.answer !== "approve") {
    return Option.none<PendingApproval>();
  }
  return (yield* pendingApprovals.byId(event.pendingApprovalId)).pipe(
    Option.filter((approval) => ranOnApproval.has(approval.state))
  );
});

const approvalResultRecovery = (approval: PendingApproval) => ({
  resumeUnsent: () => Effect.succeed("unanswered" as const),
  failureNoticeText: Effect.succeed(honestFailureText),
  session: mainConversation,
  inputs: [approvalResultInput(approval)],
});

const settleResultTurn = Effect.fnUntraced(function* settleResultTurn(
  event: ApprovalAnsweredEvent,
  result: ModelTurnResult
) {
  const inbox = yield* Inbox;
  switch (result._tag) {
    case "Sent":
    case "Silent":
    case "Superseded": {
      yield* inbox.markDone([event]);
      break;
    }
    case "Failed": {
      yield* failWithNotice({
        event,
        session: mainConversation,
        reason: result.reason,
      });
      break;
    }
    case "SendFailed": {
      yield* fail(event, result.reason);
      break;
    }
    default: {
      return result satisfies never;
    }
  }
});

export interface ApprovalResult {
  readonly ownerId: OwnerId;
  readonly settings: ApprovalAnswerSettings;
  readonly event: ApprovalAnsweredEvent;
  readonly approval: PendingApproval;
}

const runResultTurn = Effect.fnUntraced(function* runResultTurn({
  ownerId,
  settings,
  event,
  approval,
}: ApprovalResult) {
  const inbox = yield* Inbox;
  const { behavior } = settings;
  const tools = yield* toolsOfTurn(settings, event.eventId);
  if (Option.isNone(tools)) {
    yield* approvalPathLog({
      pendingApprovalId: approval.pendingApprovalId,
      step: "result_turn_without_tools",
      toolName: approval.toolName,
    });
    yield* inbox.markDone([event]);
    return;
  }
  const openApprovals = yield* openApprovalsSection;
  const result = yield* runModelTurn({
    ownerId,
    behavior,
    session: mainConversation,
    kind: {
      task: "reply",
      event,
      inputs: [approvalResultInput(approval)],
      instructions: [staySilentSection, reactSection],
      tools: tools.value,
      trustLevel: approval.trustLevel,
      asksOwnerForApproval: true,
      needsTextReply: true,
      prepare: Effect.succeed({
        situation: openApprovals.situation,
        listsUntrustedPendingApproval:
          openApprovals.listsUntrustedPendingApproval,
        lateText: (text: string) => text,
      }),
      traceOf: (model) => traceOf({ event, ...model }),
    },
  }).pipe(
    whileAcknowledging(event.conversationId, behavior.typingRepeatMillis)
  );
  yield* settleResultTurn(event, result);
});

export const answerWithApprovalResult = Effect.fnUntraced(
  function* answerWithApprovalResult(result: ApprovalResult) {
    const settled = yield* settleFromJournal(
      result.event,
      approvalResultRecovery(result.approval)
    );
    if (settled === "unanswered") {
      yield* runResultTurn(result);
    }
  }
);
