import type { ModelMessage, UserContent } from "ai";

import {
  runBlockEndLabel,
  runBlockLabel,
  turnContextEndLabel,
  turnContextLabel,
} from "./context-labels.ts";

export const turnContextBlock = (
  currentTime: string,
  situation: readonly string[]
) =>
  [turnContextLabel, currentTime, ...situation, turnContextEndLabel].join("\n");

export const runBlock = (currentTime: string, situation: readonly string[]) =>
  [runBlockLabel, currentTime, ...situation, runBlockEndLabel].join("\n");

const startingWith = (turnContext: string, content: UserContent): UserContent =>
  typeof content === "string"
    ? `${turnContext}\n${content}`
    : [{ type: "text", text: turnContext }, ...content];

export const withTurnContext = (
  turnContext: string | undefined,
  inputs: readonly ModelMessage[]
): readonly ModelMessage[] => {
  const [first, ...rest] = inputs;
  if (turnContext === undefined) {
    return inputs;
  }
  if (first?.role !== "user") {
    return [{ role: "user", content: turnContext }, ...inputs];
  }
  return [
    { ...first, content: startingWith(turnContext, first.content) },
    ...rest,
  ];
};
