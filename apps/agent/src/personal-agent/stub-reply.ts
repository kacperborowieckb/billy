import type { ModelStep } from "../model-gateway/model-step.ts";
import { removedInputStub } from "./tool-call-stubs.ts";
import { toolPartsOf } from "./turn-record.ts";

export const stubOnlyReplyReason =
  "The model sent only history Stubs in place of a reply";

const stubPatterns = [
  /\[[^[\]]*\]\s*sent to the Owner\. Text removed from the history/giu,
  /\[[^[\]]*removed from the history[^[\]]*\]/giu,
];

const writeBackRunLine = /^\((?:done in this run|read): .*\)$/gmu;

const letterOrDigit = /[\p{L}\p{N}]/u;

export const holdsOnlyStubs = (text: string) => {
  let rest = text.replaceAll(JSON.stringify(removedInputStub), "");
  for (const pattern of stubPatterns) {
    rest = rest.replaceAll(pattern, "");
  }
  return (
    rest !== text && !letterOrDigit.test(rest.replaceAll(writeBackRunLine, ""))
  );
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
