import type {
  AssistantContent,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
} from "ai";
import { Schema } from "effect";

import { pendingApprovalIdOfOutput } from "../approval/draft-approval.ts";

export type ToolOutput = ToolResultPart["output"];

const isNoteId = Schema.is(Schema.String.pipe(Schema.check(Schema.isUUID())));

const collectNoteIds = (value: unknown, found: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNoteIds(item, found);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "noteId" && isNoteId(field)) {
      found.add(field);
    } else {
      collectNoteIds(field, found);
    }
  }
};

export const noteIdsOf = (value: unknown): readonly string[] => {
  const found = new Set<string>();
  collectNoteIds(value, found);
  return [...found];
};

const failedOutputTypes: ReadonlySet<ToolOutput["type"]> = new Set([
  "error-text",
  "error-json",
  "execution-denied",
]);

export const toolCallStatusOf = (output: ToolOutput | undefined) => {
  if (output === undefined) {
    return "no result";
  }
  if (failedOutputTypes.has(output.type)) {
    return "failed";
  }
  const pendingApprovalId =
    output.type === "text"
      ? pendingApprovalIdOfOutput(output.value)
      : undefined;
  return pendingApprovalId === undefined
    ? "done"
    : `waits for Approval ${pendingApprovalId}`;
};

const isToolName = Schema.is(
  Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z]+(?:_[a-z]+){0,3}$/u))
  )
);

export const storedToolNameOf = (toolName: string) =>
  isToolName(toolName) ? toolName : "unknown_tool";

export const toolOutputsOf = (steps: readonly ModelMessage[]) => {
  const outputs = new Map<string, ToolOutput>();
  for (const message of steps) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          outputs.set(part.toolCallId, part.output);
        }
      }
    }
  }
  return outputs;
};

type AssistantPart = Exclude<AssistantContent, string>[number];

export const assistantPartsOf = (
  message: ModelMessage
): readonly AssistantPart[] => {
  if (message.role !== "assistant") {
    return [];
  }
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
};

export const isToolCall = (part: AssistantPart): part is ToolCallPart =>
  part.type === "tool-call";
