import type { LanguageModelUsage, StepResult, ToolSet } from "ai";

import type {
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
    if (part.type === "tool-approval-response" && !part.approved) {
      return [
        {
          callId: part.toolCall.toolCallId,
          name: part.toolCall.toolName,
          input: stringify(part.toolCall.input),
          output: part.reason ?? "",
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

const answeredByApproval = (part: StepResult<ToolSet>["content"][number]) =>
  part.type === "tool-approval-response" && !part.approved
    ? [part.toolCall.toolCallId]
    : [];

export const pendingToolCallsOf = (
  step: StepResult<ToolSet>
): readonly PendingToolCall[] => {
  const answered = new Set(
    step.content.flatMap((part) =>
      part.type === "tool-result" || part.type === "tool-error"
        ? [part.toolCallId]
        : answeredByApproval(part)
    )
  );
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

export const modelStepOf = (step: StepResult<ToolSet>): ModelStep => ({
  usage: usageOf(step.usage),
  toolCalls: toolCallsOf(step),
  responseMessages: step.response.messages,
});
