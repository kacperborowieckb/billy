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

export const trustLevelOfParts = (
  parts: readonly { readonly trustLevel: TrustLevel }[]
): TrustLevel =>
  parts.some((part) => part.trustLevel === "untrusted") ? "untrusted" : "owner";

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

export interface TurnTrustSource {
  readonly trustLevel: TrustLevel;
  readonly historyTrustLevel: TrustLevel;
  readonly inputs: readonly ModelMessage[];
  readonly turnContext: string;
  readonly listsUntrustedPendingApproval?: boolean | undefined;
}

const startTrustLevelOf = ({
  trustLevel,
  historyTrustLevel,
  inputs,
  turnContext,
  listsUntrustedPendingApproval,
}: TurnTrustSource): TrustLevel =>
  trustLevel === "owner" &&
  (historyTrustLevel === "untrusted" ||
    listsUntrustedPendingApproval === true ||
    holdsUntrustedContent([inputs, turnContext]))
    ? "untrusted"
    : trustLevel;

export const turnTrustGiven = (
  source: TurnTrustSource,
  earlierMessagesOfTurn: readonly ModelMessage[]
): TurnTrust =>
  turnTrustFollowingToolResults(
    startTrustLevelOf(source),
    earlierMessagesOfTurn
  );
