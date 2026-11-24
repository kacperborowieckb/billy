import type { ModelMessage } from "ai";
import { Option } from "effect";

import { holdsUntrustedContent } from "../notes/note.ts";
import type { TrustLevel } from "../notes/note.ts";

export interface ToolResultOfTurn {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

export interface TrustLevelChange {
  readonly trustLevel: "untrusted";
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface TurnTrust {
  readonly current: () => TrustLevel;
  readonly change: () => Option.Option<TrustLevelChange>;
  readonly readToolResults: (results: readonly ToolResultOfTurn[]) => void;
}

interface TurnTrustSource {
  readonly trustLevel: TrustLevel;
  readonly asksOwnerForApproval?: boolean | undefined;
}

const toolResultsOf = (
  messages: readonly ModelMessage[]
): readonly ToolResultOfTurn[] =>
  messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result"
            ? [
                {
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: part.output,
                },
              ]
            : []
        )
      : []
  );

const untrustedChangeOf = (
  results: readonly ToolResultOfTurn[]
): Option.Option<TrustLevelChange> =>
  Option.fromNullishOr(
    results.find((result) => holdsUntrustedContent(result.output))
  ).pipe(
    Option.map(({ toolCallId, toolName }) => ({
      trustLevel: "untrusted",
      toolCallId,
      toolName,
    }))
  );

const turnTrust = (
  startTrustLevel: TrustLevel,
  followsToolResults: boolean,
  earlierMessagesOfTurn: readonly ModelMessage[]
): TurnTrust => {
  let change = Option.none<TrustLevelChange>();
  const readToolResults = (results: readonly ToolResultOfTurn[]) => {
    if (
      followsToolResults &&
      startTrustLevel === "owner" &&
      Option.isNone(change)
    ) {
      change = untrustedChangeOf(results);
    }
  };
  readToolResults(toolResultsOf(earlierMessagesOfTurn));
  return {
    current: () => (Option.isSome(change) ? "untrusted" : startTrustLevel),
    change: () => change,
    readToolResults,
  };
};

export const turnTrustFollowingToolResults = (
  startTrustLevel: TrustLevel,
  earlierMessagesOfTurn: readonly ModelMessage[]
): TurnTrust => turnTrust(startTrustLevel, true, earlierMessagesOfTurn);

export const fixedTurnTrust = (trustLevel: TrustLevel): TurnTrust =>
  turnTrust(trustLevel, false, []);

export const turnTrustOf = (
  { trustLevel, asksOwnerForApproval }: TurnTrustSource,
  earlierMessagesOfTurn: readonly ModelMessage[]
): TurnTrust =>
  asksOwnerForApproval === true
    ? turnTrustFollowingToolResults(trustLevel, earlierMessagesOfTurn)
    : fixedTurnTrust(trustLevel);

export interface TurnTrustContext {
  readonly situation: readonly string[];
  readonly listsUntrustedPendingApproval?: boolean | undefined;
}

export const turnTrustGiven = (
  source: TurnTrustSource & { readonly inputs: readonly ModelMessage[] },
  { situation, listsUntrustedPendingApproval }: TurnTrustContext,
  earlierMessagesOfTurn: readonly ModelMessage[]
): TurnTrust =>
  turnTrustOf(
    {
      ...source,
      trustLevel:
        source.asksOwnerForApproval === true &&
        source.trustLevel === "owner" &&
        (listsUntrustedPendingApproval === true ||
          holdsUntrustedContent([source.inputs, situation]))
          ? "untrusted"
          : source.trustLevel,
    },
    earlierMessagesOfTurn
  );
