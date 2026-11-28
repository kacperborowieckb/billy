import type { ToolApprovalStatus } from "ai";
import { Effect } from "effect";

import {
  decisionAfterReview,
  gateDecisionOf,
  reviewStoppedReason,
} from "../approval/tool-gate.ts";
import type {
  ReviewVerdict,
  SettledGateDecision,
} from "../approval/tool-gate.ts";
import type { TurnTrust } from "../approval/turn-trust.ts";
import { toolNamed } from "./agent-tool.ts";
import type { AgentTool, AgentTools, ToolInputGate } from "./agent-tool.ts";

export interface TurnGate {
  readonly trust: TurnTrust;
  readonly asksOwnerForApproval: boolean;
  readonly callReview?: CallReview;
}

export interface ReviewedCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface CallReview {
  readonly verdictOf: (call: ReviewedCall) => Effect.Effect<ReviewVerdict>;
  readonly stopsTurn: () => boolean;
}

export const alwaysAskReview: CallReview = {
  verdictOf: () => Effect.succeed({ _tag: "Ask" }),
  stopsTurn: () => false,
};

const stopsChange = (
  tool: AgentTool,
  input: unknown,
  { callReview }: TurnGate
) => callReview?.stopsTurn() === true && tool.riskClassOf(input) === "change";

export const toolInputGateOf =
  (tool: AgentTool, turnGate: TurnGate): ToolInputGate =>
  (input) =>
    stopsChange(tool, input, turnGate)
      ? { _tag: "Deny", reason: reviewStoppedReason }
      : gateDecisionOf({
          tool,
          input,
          trustLevel: turnGate.trust.current(),
          asksOwnerForApproval: turnGate.asksOwnerForApproval,
        });

const approvalStatusOfDecision = (
  decision: SettledGateDecision
): ToolApprovalStatus => {
  if (decision._tag === "Deny") {
    return { type: "denied", reason: decision.reason };
  }
  if (decision._tag !== "AskOwner") {
    return "not-applicable";
  }
  return decision.reviewerReason === undefined
    ? "user-approval"
    : { type: "user-approval", reason: decision.reviewerReason };
};

export const approvalStatusOf =
  (
    tools: AgentTools,
    turnGate: TurnGate,
    reviewVerdictOf: (call: ReviewedCall) => Promise<ReviewVerdict>
  ) =>
  async ({
    toolCall,
  }: {
    readonly toolCall: ReviewedCall;
  }): Promise<ToolApprovalStatus> => {
    const tool = toolNamed(tools, toolCall.toolName);
    if (tool === undefined) {
      return "not-applicable";
    }
    const decision = toolInputGateOf(tool, turnGate)(toolCall.input);
    return approvalStatusOfDecision(
      decision._tag === "AskReviewer"
        ? decisionAfterReview(
            await reviewVerdictOf(toolCall),
            turnGate.asksOwnerForApproval
          )
        : decision
    );
  };

const anyBlockedInput = "{}";

export const blockedCallReachingTheGate =
  (tools: AgentTools) =>
  <Call extends { readonly toolName: string; readonly input: string }>({
    toolCall,
  }: {
    readonly toolCall: Call;
  }): Promise<Call | null> =>
    Promise.resolve(
      toolNamed(tools, toolCall.toolName)?.riskClass === "blocked"
        ? { ...toolCall, input: anyBlockedInput }
        : null
    );
