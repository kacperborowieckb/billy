import type {
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
  UserContent,
} from "ai";
import { Context, Effect, Layer } from "effect";

import {
  untrustedContentClosing,
  untrustedContentOpening,
} from "../notes/note.ts";
import { holdsOnlyStubs } from "./stub-reply.ts";
import {
  removedInputStub,
  resultStubOf,
  storedCallIdOf,
} from "./tool-call-stubs.ts";
import type { StubSource } from "./tool-call-stubs.ts";
import {
  assistantPartsOf,
  isToolCall,
  storedToolNameOf,
  toolOutputsOf,
} from "./tool-steps.ts";
import type { ToolOutput } from "./tool-steps.ts";

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

const pairStubbed = Effect.fnUntraced(function* pairStubbed(
  call: ToolCallPart,
  output: ToolOutput | undefined,
  source: StubSource
) {
  const toolCallId = yield* storedCallIdOf(source.turnEventId, call.toolCallId);
  const toolName = storedToolNameOf(call.toolName);
  return {
    call: {
      type: "tool-call",
      toolCallId,
      toolName,
      input: removedInputStub,
    } satisfies ToolCallPart,
    result: {
      type: "tool-result",
      toolCallId,
      toolName,
      output: resultStubOf({ removed: "Result", call, output, source }),
    } satisfies ToolResultPart,
  };
});

const stepStubbed = Effect.fnUntraced(function* stepStubbed(
  message: ModelMessage,
  outputs: ReadonlyMap<string, ToolOutput>,
  source: StubSource
) {
  const pairs = yield* Effect.all(
    assistantPartsOf(message)
      .filter(isToolCall)
      .map((call) => pairStubbed(call, outputs.get(call.toolCallId), source))
  );
  const stored: readonly ModelMessage[] =
    pairs.length === 0
      ? []
      : [
          { role: "assistant", content: pairs.map((pair) => pair.call) },
          { role: "tool", content: pairs.map((pair) => pair.result) },
        ];
  return stored;
});

export const untrustedStepsStubbed = Effect.fnUntraced(
  function* untrustedStepsStubbed(
    steps: readonly ModelMessage[],
    source: StubSource
  ) {
    const outputs = toolOutputsOf(steps);
    const stored = yield* Effect.all(
      steps.map((message) => stepStubbed(message, outputs, source))
    );
    return stored.flat();
  }
);

const withoutStubReplyText = (
  message: ModelMessage
): readonly ModelMessage[] => {
  if (message.role !== "assistant") {
    return [message];
  }
  const parts = assistantPartsOf(message);
  const kept = parts.filter(
    (part) => part.type !== "text" || !holdsOnlyStubs(part.text)
  );
  if (kept.length === parts.length) {
    return [message];
  }
  return kept.length === 0 ? [] : [{ ...message, content: kept }];
};

const sizeOf = (output: ToolOutput) => JSON.stringify(output).length;

interface LargeResultRules {
  readonly calls: ReadonlyMap<string, ToolCallPart>;
  readonly limits: StoredFormLimitValues;
  readonly source: StubSource;
}

const largeResultStubbed = (
  part: ToolResultPart,
  { calls, limits, source }: LargeResultRules
): ToolResultPart => {
  const size = sizeOf(part.output);
  if (size <= limits.maxStoredToolResultCharacters) {
    return part;
  }
  return {
    ...part,
    output: resultStubOf({
      removed: `Result of ${size} characters`,
      call: calls.get(part.toolCallId) ?? {
        toolName: part.toolName,
        input: undefined,
      },
      output: part.output,
      source,
    }),
  };
};

const largeResultsStubbed = (
  message: ModelMessage,
  rules: LargeResultRules
): ModelMessage =>
  message.role === "tool"
    ? {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool-result" ? largeResultStubbed(part, rules) : part
        ),
      }
    : message;

export const trustedStepsLimited = (
  steps: readonly ModelMessage[],
  limits: StoredFormLimitValues,
  source: StubSource
): readonly ModelMessage[] => {
  const calls = new Map(
    steps
      .flatMap((message) => assistantPartsOf(message).filter(isToolCall))
      .map((call) => [call.toolCallId, call])
  );
  return steps
    .flatMap(withoutStubReplyText)
    .map((message) => largeResultsStubbed(message, { calls, limits, source }));
};
