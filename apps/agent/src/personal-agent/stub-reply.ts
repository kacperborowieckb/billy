import type { ModelStep } from "../model-gateway/model-step.ts";
import { toolPartsOf } from "./turn-record.ts";

export const stubOnlyReplyReason =
  "The model sent only history Stubs in place of a reply";

const stubPatterns = [
  /\{\s*"removed"\s*:\s*"\[Input removed from the history\]"\s*\}/gu,
  /\[[^[\]]*\]\s*sent to the Owner\. Text removed from the history/giu,
  /\[[^[\]]*removed from the history[^[\]]*\]/giu,
];

const linesAroundStubs = [
  /^\((?:done in this run|read): .*\)$/gmu,
  /^\s*(?:`{3,}|~{3,})[\w-]*\s*$/gmu,
];

const letterOrDigit = /[\p{L}\p{N}]/u;

export const holdsOnlyStubs = (text: string) => {
  let rest = text;
  for (const pattern of stubPatterns) {
    rest = rest.replaceAll(pattern, "");
  }
  if (rest === text) {
    return false;
  }
  for (const pattern of linesAroundStubs) {
    rest = rest.replaceAll(pattern, "");
  }
  return !letterOrDigit.test(rest);
};

export const withoutReplyText = (
  steps: readonly ModelStep[]
): readonly ModelStep[] => {
  const last = steps.at(-1);
  return last === undefined
    ? steps
    : [
        ...steps.slice(0, -1),
        {
          ...last,
          responseMessages: last.responseMessages.flatMap(toolPartsOf),
        },
      ];
};
