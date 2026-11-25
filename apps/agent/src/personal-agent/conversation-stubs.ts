import type {
  AssistantContent,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
  UserContent,
} from "ai";
import { Context, Layer, Schema } from "effect";

import { pendingApprovalIdOfOutput } from "../approval/draft-approval.ts";
import {
  untrustedContentClosing,
  untrustedContentOpening,
} from "../notes/note.ts";

export interface StoredFormLimitValues {
  readonly maxStoredToolResultCharacters: number;
}

export class StoredFormLimits extends Context.Service<
  StoredFormLimits,
  StoredFormLimitValues
>()("StoredFormLimits") {
  static readonly layer = (limitsOf: () => StoredFormLimitValues) =>
    Layer.sync(StoredFormLimits, limitsOf);
}

export const untrustedContentStub =
  "[Untrusted Content removed from the history]";

export const untrustedReplyStub =
  "[Reply sent to the Owner. Text removed from the history]";

const untrustedModelTextStub = "[Model text removed from the history]";

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

const noteIdsText = (value: unknown) => {
  const ids = noteIdsOf(value);
  return ids.length === 0 ? "" : ` Note ids: ${ids.join(", ")}.`;
};

type ToolOutput = ToolResultPart["output"];

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

const sizeOf = (output: ToolOutput) => JSON.stringify(output).length;

export const largeToolResultStub = (toolName: string, output: ToolOutput) =>
  `[${toolName} result of ${sizeOf(output)} characters removed from the history.${noteIdsText(output)} Call the tool again to read it]`;

const isToolName = Schema.is(
  Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z]+(?:_[a-z]+){0,3}$/u))
  )
);

export const storedToolNameOf = (toolName: string) =>
  isToolName(toolName) ? toolName : "unknown_tool";

export const untrustedToolCallStub = (
  toolName: string,
  output: ToolOutput | undefined
) =>
  `[${storedToolNameOf(toolName)}: ${toolCallStatusOf(output)}.${noteIdsText(output)} Input and result removed from the history]`;

export const withUntrustedContentStubbed = (text: string): string => {
  const start = text.indexOf(untrustedContentOpening);
  if (start === -1) {
    return text;
  }
  const close = text.indexOf(untrustedContentClosing, start);
  const rest =
    close === -1 ? "" : text.slice(close + untrustedContentClosing.length);
  return `${text.slice(0, start)}${untrustedContentStub}${withUntrustedContentStubbed(rest)}`;
};

const userContentStubbed = (content: UserContent): UserContent =>
  typeof content === "string"
    ? withUntrustedContentStubbed(content)
    : content.map((part) =>
        part.type === "text"
          ? { ...part, text: withUntrustedContentStubbed(part.text) }
          : part
      );

export const inputStubbed = (message: ModelMessage): ModelMessage =>
  message.role === "user"
    ? { ...message, content: userContentStubbed(message.content) }
    : message;

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

const holdsModelText = (parts: readonly AssistantPart[]) =>
  parts.some((part) => part.type === "text" && part.text.trim() !== "");

export const untrustedStepsStubbed = (
  steps: readonly ModelMessage[]
): readonly ModelMessage[] => {
  const outputs = toolOutputsOf(steps);
  const stubs = steps.flatMap((message) => {
    const parts = assistantPartsOf(message);
    return [
      ...(holdsModelText(parts) ? [untrustedModelTextStub] : []),
      ...parts
        .filter(isToolCall)
        .map((call) =>
          untrustedToolCallStub(call.toolName, outputs.get(call.toolCallId))
        ),
    ];
  });
  return stubs.length === 0
    ? []
    : [{ role: "assistant", content: stubs.join("\n") }];
};

const toolResultLimited = (
  part: ToolResultPart,
  { maxStoredToolResultCharacters }: StoredFormLimitValues
): ToolResultPart =>
  sizeOf(part.output) > maxStoredToolResultCharacters
    ? {
        ...part,
        output: {
          type: "text",
          value: largeToolResultStub(part.toolName, part.output),
        },
      }
    : part;

export const trustedStepsLimited = (
  steps: readonly ModelMessage[],
  limits: StoredFormLimitValues
): readonly ModelMessage[] =>
  steps.map((message) =>
    message.role === "tool"
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" ? toolResultLimited(part, limits) : part
          ),
        }
      : message
  );
