import type { Redactor } from "../tracing/redactor.ts";
import type { ReplyTurnTrace } from "../tracing/turn-trace.ts";
import type { OutcomeKind } from "./storage-values.ts";
import type { ReactionOutcome } from "./turn-record.ts";

export const traceOutcomeOf = (
  outcomeKind: OutcomeKind | undefined,
  reaction: ReactionOutcome | undefined,
  redactor: Redactor["Service"]
): ReplyTurnTrace["outcome"] => {
  if (outcomeKind === undefined) {
    return null;
  }
  if (outcomeKind !== "reaction" || reaction === undefined) {
    return { kind: outcomeKind };
  }
  return {
    kind: outcomeKind,
    emoji: reaction.emoji,
    ...(reaction.requestedEmoji === undefined
      ? {}
      : { requestedEmoji: redactor.redact(reaction.requestedEmoji) }),
  };
};
