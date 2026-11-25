import type { AssistantContent, ModelMessage, ToolContent } from "ai";
import { Effect } from "effect";

import { holdsUntrustedContent } from "../notes/note.ts";
import { Redactor } from "../tracing/redactor.ts";
import {
  inputStubbed,
  trustedStepsLimited,
  untrustedReplyStub,
  StoredFormLimits,
  untrustedStepsStubbed,
} from "./conversation-stubs.ts";
import type { StoredFormLimitValues } from "./conversation-stubs.ts";
import { Conversation } from "./conversation.ts";
import type { ConversationRow } from "./conversation.ts";
import { withTurnContext } from "./turn-context.ts";

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
  readonly recordedAs?: string | undefined;
  readonly turnContext?: string | undefined;
  readonly inputs: readonly ModelMessage[];
  readonly steps: readonly ModelMessage[];
  readonly ending: TurnEnding;
}

const endingRowsOf = (
  ending: TurnEnding,
  heldUntrustedContent: boolean
): readonly ConversationRow[] =>
  ending._tag === "Replied"
    ? [
        {
          kind: "reply",
          message: {
            role: "assistant",
            content: heldUntrustedContent ? untrustedReplyStub : ending.text,
          },
        },
      ]
    : [];

const rowsOfKind = (
  kind: ConversationRow["kind"],
  messages: readonly ModelMessage[]
): readonly ConversationRow[] => messages.map((message) => ({ kind, message }));

interface StoredForm {
  readonly rows: readonly ConversationRow[];
  readonly withStub: boolean;
}

const storedFormWithStubsOf = (
  { turnContext, inputs, steps, ending }: FinishedTurn,
  redactor: Redactor["Service"],
  limits: StoredFormLimitValues
): StoredForm => {
  if (ending._tag === "Unanswered" && steps.length === 0) {
    return { rows: [], withStub: false };
  }
  const sentInputs = withTurnContext(turnContext, inputs).map((input) =>
    redactor.redactMessage(input)
  );
  const heldUntrustedContent = holdsUntrustedContent([sentInputs, steps]);
  const storedSteps = heldUntrustedContent
    ? untrustedStepsStubbed(steps)
    : trustedStepsLimited(steps, limits);
  return {
    rows: [
      ...rowsOfKind(
        "input",
        heldUntrustedContent ? sentInputs.map(inputStubbed) : sentInputs
      ),
      ...rowsOfKind("step", storedSteps),
      ...endingRowsOf(ending, heldUntrustedContent),
    ],
    withStub:
      heldUntrustedContent ||
      JSON.stringify(storedSteps) !== JSON.stringify(steps),
  };
};

export const storedFormOf = (
  turn: FinishedTurn,
  redactor: Redactor["Service"],
  limits: StoredFormLimitValues
): readonly ConversationRow[] =>
  storedFormWithStubsOf(turn, redactor, limits).rows;

export const storeFinishedTurn = Effect.fnUntraced(function* storeFinishedTurn(
  turn: FinishedTurn
) {
  const conversation = yield* Conversation;
  const redactor = yield* Redactor;
  const { rows, withStub } = storedFormWithStubsOf(
    turn,
    redactor,
    yield* StoredFormLimits
  );
  if (rows.length > 0) {
    yield* conversation.append({
      eventId: turn.eventId,
      recordedAs: turn.recordedAs,
      rows,
      storedWithStub: withStub,
    });
  }
});
