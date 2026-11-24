import { Schema } from "effect";

import {
  ownerContextLabel,
  turnContextLabel,
} from "../src/personal-agent/context-labels.ts";

export const ChatCompletionBodySchema = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, content: Schema.Unknown })
  ),
});

export const lastOwnerText = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const content = messages.findLast(
    (message) => message.role === "user"
  )?.content;
  return typeof content === "string" ? content : "";
};

const textContentOf = (content: unknown) =>
  typeof content === "string" ? content : "";

const latestContextBlock = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"],
  label: string
) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) => textContentOf(message.content))
    .findLast((text) => text.startsWith(label)) ?? "";

export const instructionsAndContextOf = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) =>
  [
    textContentOf(
      messages.find((message) => message.role === "system")?.content
    ),
    latestContextBlock(messages, ownerContextLabel),
    latestContextBlock(messages, turnContextLabel),
  ].join("\n");

export const toolResultOf = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const last = messages.at(-1);
  return last?.role === "tool" && typeof last.content === "string"
    ? last.content
    : undefined;
};
