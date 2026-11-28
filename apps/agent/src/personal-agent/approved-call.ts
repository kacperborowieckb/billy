import { Cause, Effect, Option } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import { approvalPathLog } from "../approval/approval-log.ts";
import { PendingApprovals } from "../approval/pending-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import { failureReasonOf } from "../mcp/mcp-failure.ts";
import {
  toolNamed,
  unexpectedToolFailureMessage,
} from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { Redactor } from "../tracing/redactor.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import type { Burst } from "./burst.ts";
import { Inbox } from "./inbox.ts";
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
  const linkedEventIds = yield* journal.eventIdsAnsweredByTurn(turnEventId);
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

const originBurstOf = Effect.fnUntraced(function* originBurstOf(
  turnEventId: string
) {
  const inbox = yield* Inbox;
  const pendingApprovals = yield* PendingApprovals;
  const visited = new Set<string>();
  let eventId = turnEventId;
  while (!visited.has(eventId)) {
    visited.add(eventId);
    const burst = yield* burstOfTurn(eventId);
    if (Option.isSome(burst)) {
      return burst;
    }
    const answeredApprovalId = yield* inbox.answeredApprovalIdOf(eventId);
    const answered = Option.isSome(answeredApprovalId)
      ? yield* pendingApprovals.byId(answeredApprovalId.value)
      : Option.none<PendingApproval>();
    if (Option.isNone(answered)) {
      return Option.none<Burst>();
    }
    eventId = answered.value.turnEventId;
  }
  return Option.none<Burst>();
});

export const toolsOfTurn = Effect.fnUntraced(function* toolsOfTurn(
  { behavior, tools }: ApprovalAnswerSettings,
  turnEventId: string
) {
  const burst = yield* originBurstOf(turnEventId);
  if (Option.isNone(burst)) {
    return Option.none<AgentTools>();
  }
  return Option.some<AgentTools>({
    ...tools,
    ...ownerMessageTools(
      burst.value,
      { ...(yield* agentToolServices), behavior },
      turnEventId
    ),
  });
});

export const turnToolsOf = (
  settings: ApprovalAnswerSettings,
  approval: PendingApproval
) => toolsOfTurn(settings, approval.turnEventId);

export const runApprovedCall = Effect.fnUntraced(function* runApprovedCall(
  settings: ApprovalAnswerSettings,
  approval: PendingApproval
) {
  const redactor = yield* Redactor;
  const turnTools = yield* turnToolsOf(settings, approval);
  const couldNotStart = (reason: string) =>
    approvalPathLog({
      pendingApprovalId: approval.pendingApprovalId,
      step: "run_could_not_start",
      toolName: approval.toolName,
      reason,
    });
  if (Option.isNone(turnTools)) {
    yield* couldNotStart("turn_gone");
    return failedRun(turnGoneReason);
  }
  const tool = toolNamed(turnTools.value, approval.toolName);
  if (tool === undefined) {
    yield* couldNotStart("tool_gone");
    return failedRun(toolGoneReason);
  }
  return yield* tool
    .executeApproved(approval.frozenInput, approval.pendingApprovalId)
    .pipe(
      Effect.map(
        (output): ApprovalRunOutcome =>
          tool.approvedRunOutcomeOf?.(output) ?? {
            result: "executed",
            output,
          }
      ),
      Effect.catchTag("ToolFailed", (failure) =>
        Effect.succeed(
          failure.unconfirmed === true
            ? ({ result: "unconfirmed" } as const)
            : failedRun(redactor.redact(failure.message))
        )
      ),
      Effect.catchCause((cause) =>
        approvalPathLog({
          pendingApprovalId: approval.pendingApprovalId,
          step: "run_failed_unexpectedly",
          toolName: approval.toolName,
          result: "failed",
          reason: failureReasonOf(Cause.squash(cause)),
        }).pipe(Effect.as(failedRun(unexpectedToolFailureMessage)))
      )
    );
});
