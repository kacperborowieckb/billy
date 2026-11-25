import type { ToolApprovalStatus } from "ai";

import { gateDecisionOf } from "../approval/tool-gate.ts";
import type { TurnTrust } from "../approval/turn-trust.ts";
import { toolNamed } from "./agent-tool.ts";
import type { AgentTool, AgentTools, ToolInputGate } from "./agent-tool.ts";

export interface TurnGate {
  readonly trust: TurnTrust;
  readonly asksOwnerForApproval: boolean;
}

export const toolInputGateOf =
  (tool: AgentTool, { trust, asksOwnerForApproval }: TurnGate): ToolInputGate =>
  (input) =>
    gateDecisionOf({
      tool,
      input,
      trustLevel: trust.current(),
      asksOwnerForApproval,
    });

export const approvalStatusOf =
  (tools: AgentTools, turnGate: TurnGate) =>
  ({
    toolCall,
  }: {
    readonly toolCall: { readonly toolName: string; readonly input: unknown };
  }): ToolApprovalStatus => {
    const tool = toolNamed(tools, toolCall.toolName);
    if (tool === undefined) {
      return "not-applicable";
    }
    const decision = toolInputGateOf(tool, turnGate)(toolCall.input);
    if (decision._tag === "Deny") {
      return { type: "denied", reason: decision.reason };
    }
    return decision._tag === "AskOwner" ? "user-approval" : "not-applicable";
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
