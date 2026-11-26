import { Effect, Option } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
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

export const turnToolsOf = Effect.fnUntraced(function* turnToolsOf(
  { behavior, tools }: ApprovalAnswerSettings,
  approval: PendingApproval
) {
  const burst = yield* burstOfTurn(approval.turnEventId);
  if (Option.isNone(burst)) {
    return Option.none<AgentTools>();
  }
  return Option.some<AgentTools>({
    ...tools,
    ...ownerMessageTools(burst.value, {
      ...(yield* agentToolServices),
      behavior,
    }),
  });
});

export const runApprovedCall = Effect.fnUntraced(function* runApprovedCall(
  settings: ApprovalAnswerSettings,
  approval: PendingApproval
) {
  const redactor = yield* Redactor;
  const turnTools = yield* turnToolsOf(settings, approval);
  if (Option.isNone(turnTools)) {
    return failedRun(turnGoneReason);
  }
  const tool = toolNamed(turnTools.value, approval.toolName);
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
