import type { ToolApprovalStatus } from "ai";

import { gateDecisionOf } from "../approval/tool-gate.ts";
import type { TrustLevel } from "../notes/note.ts";
import type { AgentTools } from "./agent-tool.ts";

export const approvalStatusOf =
  (tools: AgentTools, trustLevel: TrustLevel) =>
  ({
    toolCall,
  }: {
    readonly toolCall: { readonly toolName: string; readonly input: unknown };
  }): ToolApprovalStatus => {
    const tool = Object.hasOwn(tools, toolCall.toolName)
      ? tools[toolCall.toolName]
      : undefined;
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
