import type { ToolApprovalStatus } from "ai";

import { gateDecisionOf } from "../approval/tool-gate.ts";
import type { TrustLevel } from "../notes/note.ts";
import { toolNamed } from "./agent-tool.ts";
import type { AgentTools } from "./agent-tool.ts";

export const approvalStatusOf =
  (tools: AgentTools, trustLevel: TrustLevel) =>
  ({
    toolCall,
  }: {
    readonly toolCall: { readonly toolName: string; readonly input: unknown };
  }): ToolApprovalStatus => {
    const tool = toolNamed(tools, toolCall.toolName);
    if (tool === undefined) {
      return "not-applicable";
    }
    const decision = gateDecisionOf({
      tool,
      input: toolCall.input,
      trustLevel,
    });
    return decision._tag === "Deny"
      ? { type: "denied", reason: decision.reason }
      : "not-applicable";
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
