import type { AssistantContent, ModelMessage, ToolContent } from "ai";
import { Effect } from "effect";

import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import { McpConnections } from "../mcp/mcp-connections.ts";
import { leastTrusted, trustLevelOfContent } from "../notes/note.ts";
import type { TrustLevel } from "../notes/note.ts";
import { Redactor } from "../tracing/redactor.ts";
import {
  inputStubbed,
  trustedStepsLimited,
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
  readonly trustLevel: TrustLevel;
}

const endingRowsOf = (
  ending: TurnEnding,
  trustLevel: TrustLevel
): readonly ConversationRow[] =>
  ending._tag === "Replied"
    ? [
        {
          kind: "reply",
          message: { role: "assistant", content: ending.text },
          trustLevel,
        },
      ]
    : [];

const ownerTrustRowsOf = (
  kind: "input" | "step",
  messages: readonly ModelMessage[]
): readonly ConversationRow[] =>
  messages.map((message) => ({ kind, message, trustLevel: "owner" }));

interface StoredForm {
  readonly rows: readonly ConversationRow[];
  readonly withStub: boolean;
}

export interface StoredFormRules {
  readonly redactor: Redactor["Service"];
  readonly limits: StoredFormLimitValues;
  readonly mcpCatalog: McpCatalog;
}

export interface TurnInConversation extends FinishedTurn {
  readonly historyTrustLevel: TrustLevel;
}

const storedFormWithStubsOf = Effect.fnUntraced(function* storedFormWithStubsOf(
  {
    eventId,
    turnContext,
    inputs,
    steps,
    ending,
    trustLevel: runTrustLevel,
    historyTrustLevel,
  }: TurnInConversation,
  { redactor, limits, mcpCatalog }: StoredFormRules
) {
  if (ending._tag === "Unanswered" && steps.length === 0) {
    return { rows: [], withStub: false } satisfies StoredForm;
  }
  const sentInputs = withTurnContext(turnContext, inputs).map((input) =>
    redactor.redactMessage(input)
  );
  const trustLevel = leastTrusted([
    runTrustLevel,
    historyTrustLevel,
    trustLevelOfContent([sentInputs, steps]),
  ]);
  const source = { turnEventId: eventId, mcpCatalog };
  const storedInputs =
    trustLevel === "untrusted" ? sentInputs.map(inputStubbed) : sentInputs;
  const storedSteps =
    trustLevel === "untrusted"
      ? yield* untrustedStepsStubbed(steps, source)
      : trustedStepsLimited(steps, limits, source);
  return {
    rows: [
      ...ownerTrustRowsOf("input", storedInputs),
      ...ownerTrustRowsOf("step", storedSteps),
      ...endingRowsOf(ending, trustLevel),
    ],
    withStub:
      JSON.stringify([storedInputs, storedSteps]) !==
      JSON.stringify([sentInputs, steps]),
  } satisfies StoredForm;
});

export const storedFormOf = (
  turn: TurnInConversation,
  rules: StoredFormRules
) => storedFormWithStubsOf(turn, rules).pipe(Effect.map((form) => form.rows));

export const storeFinishedTurn = Effect.fnUntraced(function* storeFinishedTurn(
  turn: FinishedTurn
) {
  const conversation = yield* Conversation;
  const { rows, withStub } = yield* storedFormWithStubsOf(
    { ...turn, historyTrustLevel: yield* conversation.uncompactedTrustLevel },
    {
      redactor: yield* Redactor,
      limits: yield* StoredFormLimits,
      mcpCatalog: (yield* McpConnections).catalog,
    }
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
