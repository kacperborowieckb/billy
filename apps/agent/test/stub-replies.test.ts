import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { honestFailureText } from "../src/personal-agent/delivery.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { stubOnlyReplyReason } from "../src/personal-agent/stub-reply.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import { telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const copiedStubs = [
  "[Result removed from the history. call_mcp_tool: done.]",
  "[Reply sent to the Owner. Text removed from the history]",
].join("\n");

const stubReply = { say: copiedStubs };

const ownerSays = async (userId: number, text: string) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
    timeout: 10_000,
  });
};

const sentTexts = () => fakeTelegram.sent.map((message) => message.body.text);

const storedMessagesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<{ message: string }>(
        "SELECT message FROM conversation_messages ORDER BY sequence"
      )
      .toArray()
      .map((row) => row.message)
  );

const replyTracesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (agent) =>
    agent.runtime.runPromise(
      TurnTraces.pipe(Effect.flatMap((traces) => traces.readReplies))
    )
  );

beforeEach(() => {
  resetFakes();
});

describe("A reply that holds only Stubs", () => {
  it("is not sent or stored, and the model step runs again with the same request", async () => {
    const ownerId = await ownerInWarsaw(9961);
    scriptModel([stubReply, { say: "Here is your answer." }]);

    await ownerSays(9961, "change the page");

    expect(sentTexts()).toEqual(["Here is your answer."]);
    const [first, second] = fakeModel.doGenerateCalls;
    expect(second?.prompt).toEqual(first?.prompt);
    const stored = await vi.waitFor(async () => {
      const messages = await storedMessagesOf(ownerId);
      expect(messages).toHaveLength(2);
      return messages;
    });
    expect(stored.join("\n")).not.toContain("removed from the history");
    const [trace] = await replyTracesOf(ownerId);
    expect(trace?.trace.rejectedStubReplies).toEqual([copiedStubs]);
  });

  it("keeps the tool calls that ran, and runs no call twice", async () => {
    const ownerId = await ownerInWarsaw(9962);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Buy tea" } },
      stubReply,
      { say: "Kept." },
    ]);

    await ownerSays(9962, "keep: buy tea");

    expect(sentTexts()).toEqual(["Kept."]);
    expect(fakeModel.doGenerateCalls.at(-1)?.prompt.at(-1)?.role).toBe("tool");
    const stored = await vi.waitFor(async () => {
      const messages = await storedMessagesOf(ownerId);
      expect(messages).toHaveLength(4);
      return messages;
    });
    expect(stored.join("\n")).not.toContain("removed from the history");
  });

  it("ends the Turn with the honest failure after the retry limit", async () => {
    const ownerId = await ownerInWarsaw(9963);
    const attempts = defaultBehaviorConfig.maxStubReplyRetries + 1;
    scriptModel(Array.from({ length: attempts }, () => stubReply));

    await ownerSays(9963, "change the page");

    expect(sentTexts()).toEqual([honestFailureText]);
    expect(fakeModel.doGenerateCalls).toHaveLength(attempts);
    const [trace] = await replyTracesOf(ownerId);
    expect(trace?.trace.error).toContain(stubOnlyReplyReason);
    expect(trace?.trace.rejectedStubReplies).toHaveLength(attempts);
  });
});
