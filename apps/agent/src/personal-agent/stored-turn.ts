import type { AssistantContent, ModelMessage, ToolContent } from "ai";
import { Effect } from "effect";

import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";

export type TurnEnding =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Reacted" }
  | { readonly _tag: "Silent" }
  | { readonly _tag: "Unanswered" };

export const replied = (text: string): TurnEnding => ({
  _tag: "Replied",
  text,
});
export const reacted: TurnEnding = { _tag: "Reacted" };
export const silent: TurnEnding = { _tag: "Silent" };
export const unanswered: TurnEnding = { _tag: "Unanswered" };

type AssistantPart = Exclude<AssistantContent, string>[number];
type ToolPart = ToolContent[number];
type RecordedPart = AssistantPart | ToolPart;

const recordedPartKey = (part: RecordedPart) =>
  part.type === "tool-call" || part.type === "tool-result"
    ? `${part.type}:${part.toolCallId}`
    : undefined;

const recordedPartsOf = (recorded: readonly ModelMessage[]) => {
  const parts = new Map<string, RecordedPart>();
  for (const message of recorded) {
    if (
      (message.role === "assistant" || message.role === "tool") &&
      typeof message.content !== "string"
    ) {
      for (const part of message.content) {
        const key = recordedPartKey(part);
        if (key !== undefined) {
          parts.set(key, part);
        }
      }
    }
  }
  return parts;
};

const recordedPartOr = <Part extends RecordedPart>(
  parts: ReadonlyMap<string, RecordedPart>,
  part: Part
) => {
  const key = recordedPartKey(part);
  return (key === undefined ? undefined : parts.get(key)) ?? part;
};

export const withRecordedToolParts = (
  messages: readonly ModelMessage[],
  recorded: readonly ModelMessage[]
): readonly ModelMessage[] => {
  const parts = recordedPartsOf(recorded);
  return messages.map((message): ModelMessage => {
    if (message.role === "assistant" && typeof message.content !== "string") {
      return {
        ...message,
        content: message.content.map(
          (part) => recordedPartOr(parts, part) as AssistantPart
        ),
      };
    }
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map(
          (part) => recordedPartOr(parts, part) as ToolPart
        ),
      };
    }
    return message;
  });
};

export interface FinishedTurn {
  readonly eventId: string;
  readonly inputs: readonly ModelMessage[];
  readonly steps: readonly ModelMessage[];
  readonly ending: TurnEnding;
}

const endingMessagesOf = (ending: TurnEnding): readonly ModelMessage[] =>
  ending._tag === "Replied"
    ? [{ role: "assistant", content: ending.text }]
    : [];

export const storedFormOf = (
  { inputs, steps, ending }: FinishedTurn,
  redactor: Redactor["Service"]
): readonly ModelMessage[] =>
  ending._tag === "Unanswered" && steps.length === 0
    ? []
    : [
        ...inputs.map((input) => redactor.redactMessage(input)),
        ...steps,
        ...endingMessagesOf(ending),
      ];

export const storeFinishedTurn = Effect.fnUntraced(function* storeFinishedTurn(
  turn: FinishedTurn
) {
  const conversation = yield* Conversation;
  const redactor = yield* Redactor;
  const stored = storedFormOf(turn, redactor);
  if (stored.length > 0) {
    yield* conversation.append(turn.eventId, stored);
  }
});
