import type { LanguageModelUsage, ModelMessage, StepResult, ToolSet } from "ai";

import type {
  ApprovalRequestedCall,
  ModelStep,
  ModelToolCall,
  PendingToolCall,
} from "./model-step.ts";
import type { Usage } from "./usage-ledger.ts";

const usageOf = (usage: LanguageModelUsage): Usage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
  costUsd: undefined,
});

const stringify = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "null");

const errorMessageOf = (error: unknown) =>
  error instanceof Error ? error.message : stringify(error);

type StepContentPart = StepResult<ToolSet>["content"][number];

const deniedCallOf = (part: StepContentPart) =>
  part.type === "tool-approval-response" && !part.approved
    ? { toolCall: part.toolCall, reason: part.reason ?? "" }
    : undefined;

const isApprovalPart = (part: { readonly type: string }) =>
  part.type === "tool-approval-request" ||
  part.type === "tool-approval-response";

const withoutApprovalParts = (message: ModelMessage): ModelMessage => {
  if (message.role === "assistant" && typeof message.content !== "string") {
    return {
      ...message,
      content: message.content.filter((part) => !isApprovalPart(part)),
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.filter((part) => !isApprovalPart(part)),
    };
  }
  return message;
};

const toolCallsOf = (step: StepResult<ToolSet>): readonly ModelToolCall[] =>
  step.content.flatMap((part): ModelToolCall[] => {
    if (part.type === "tool-result") {
      return [
        {
          callId: part.toolCallId,
          name: part.toolName,
          input: stringify(part.input),
          output: stringify(part.output),
          failed: false,
        },
      ];
    }
    const denied = deniedCallOf(part);
    if (denied !== undefined) {
      return [
        {
          callId: denied.toolCall.toolCallId,
          name: denied.toolCall.toolName,
          input: stringify(denied.toolCall.input),
          output: denied.reason,
          failed: true,
        },
      ];
    }
    if (part.type === "tool-error") {
      return [
        {
          callId: part.toolCallId,
          name: part.toolName,
          input: stringify(part.input),
          output: errorMessageOf(part.error),
          failed: true,
        },
      ];
    }
    return [];
  });

const answeredCallIdOf = (part: StepContentPart) =>
  part.type === "tool-result" || part.type === "tool-error"
    ? part.toolCallId
    : deniedCallOf(part)?.toolCall.toolCallId;

const ownerApprovalRequestOf = (part: StepContentPart) =>
  part.type === "tool-approval-request" && part.isAutomatic !== true
    ? part.toolCall
    : undefined;

export const approvalRequestedCallsOf = (
  step: StepResult<ToolSet>
): readonly ApprovalRequestedCall[] =>
  step.content.flatMap((part) => {
    const toolCall = ownerApprovalRequestOf(part);
    return toolCall === undefined
      ? []
      : [
          {
            callId: toolCall.toolCallId,
            name: toolCall.toolName,
            input: toolCall.input,
          },
        ];
  });

export const pendingToolCallsOf = (
  step: StepResult<ToolSet>
): readonly PendingToolCall[] => {
  const answered = new Set([
    ...step.content.map(answeredCallIdOf),
    ...step.content.map((part) => ownerApprovalRequestOf(part)?.toolCallId),
  ]);
  return step.content.flatMap((part) =>
    part.type === "tool-call" && !answered.has(part.toolCallId)
      ? [
          {
            callId: part.toolCallId,
            name: part.toolName,
            input: stringify(part.input),
          },
        ]
      : []
  );
};

export const modelStepOf = (
  step: StepResult<ToolSet>,
  calledAtMillis: number
): ModelStep => ({
  usage: usageOf(step.usage),
  calledAtMillis,
  toolCalls: toolCallsOf(step),
  responseMessages: step.response.messages.map(withoutApprovalParts),
});
