import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { ModelStep } from "../src/model-gateway/model-step.ts";
import { stepMessagesOfReply } from "../src/personal-agent/turn-record.ts";
import type { ModelOutcome } from "../src/personal-agent/turn-record.ts";

const usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  cachedInputTokens: undefined,
  costUsd: undefined,
};

const stepOf = (responseMessages: readonly ModelMessage[]): ModelStep => ({
  usage,
  calledAtMillis: 0,
  toolCalls: [],
  responseMessages,
});

const repliedWith = (steps: readonly ModelStep[]): ModelOutcome => ({
  _tag: "Replied",
  reply: {
    modelId: "fake",
    reasoningEffort: "low",
    text: "Kept",
    usage,
    steps,
    endedWith: [],
    awaitingApproval: [],
  },
});

const toolCall: ModelMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "Kept" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "capture_note",
      input: { text: "buy tea" },
    },
  ],
};

const toolResult: ModelMessage = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "capture_note",
      output: { type: "json", value: { noteId: "n1" } },
    },
  ],
};

const replyText: ModelMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Kept" }],
};

describe("The step messages of a reply", () => {
  it("leave out the reply text of the final step", () => {
    expect(
      stepMessagesOfReply(
        repliedWith([stepOf([toolCall, toolResult]), stepOf([replyText])])
      )
    ).toEqual([toolCall, toolResult]);
  });

  it("keep a tool call and its result that the final step holds next to the reply text", () => {
    expect(
      stepMessagesOfReply(repliedWith([stepOf([toolCall, toolResult])]))
    ).toEqual([
      { role: "assistant", content: [toolCall.content[1]] },
      toolResult,
    ]);
  });
});
