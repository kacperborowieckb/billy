import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import {
  ownerContextLabel,
  textAfterContextBlock,
  turnContextLabel,
} from "../src/personal-agent/context-labels.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { updateProfileToolName } from "../src/profile/update-profile-tool.ts";
import {
  contextBlockOf,
  fakeModel,
  fakeTelegram,
  lastUserTextOf,
  resetFakes,
  scriptModel,
  systemTextOf,
} from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import { telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ModelCall = (typeof fakeModel.doGenerateCalls)[number];

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

const calls = () => [...fakeModel.doGenerateCalls];

const lastCall = (): ModelCall => {
  const call = fakeModel.doGenerateCalls.at(-1);
  if (call === undefined) {
    throw new Error("No model call was made");
  }
  return call;
};

const messagesOf = (call: ModelCall) =>
  call.prompt.filter((message) => message.role !== "system");

const bytesOf = (value: unknown) => JSON.stringify(value);

const storedRowsOf = async (ownerId: string, table: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* storedRowsEffect() {
          const { database } = yield* AgentStorage;
          return yield* database.all<Record<string, unknown>>(
            sql.raw(`SELECT * FROM ${table}`)
          );
        })
      )
  );

beforeEach(() => {
  resetFakes();
});

describe("The request of an Owner message Turn", () => {
  it("starts with the bytes of the earlier Turn as it is stored, also after tool steps", async () => {
    await ownerInWarsaw(9801);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Buy milk" } },
      { say: "Kept." },
    ]);
    await ownerSays(9801, "keep: buy milk", 1);
    const earlierTurn = lastCall();

    await ownerSays(9801, "thanks", 2);
    const laterTurn = lastCall();

    const earlierMessages = messagesOf(earlierTurn);
    const laterMessages = messagesOf(laterTurn);
    expect(bytesOf(systemTextOf(laterTurn.prompt))).toBe(
      bytesOf(systemTextOf(earlierTurn.prompt))
    );
    expect(bytesOf(laterTurn.tools)).toBe(bytesOf(earlierTurn.tools));
    expect(bytesOf(laterMessages.slice(0, earlierMessages.length))).toBe(
      bytesOf(earlierMessages)
    );
    expect(laterMessages[earlierMessages.length]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Kept." }],
    });
    const newOwnerMessage = lastUserTextOf(laterTurn.prompt);
    expect(laterMessages).toHaveLength(earlierMessages.length + 2);
    expect(newOwnerMessage.startsWith(turnContextLabel)).toBe(true);
    expect(textAfterContextBlock(newOwnerMessage)).toBe("thanks");
  });

  it("starts with the bytes of an earlier Turn that was untrusted only because of the stored Conversation", async () => {
    await ownerInWarsaw(9807);
    scriptModel([{ say: "Ana asks for money." }, { say: "Noted." }]);
    await telegramWebhook(
      textUpdate({
        fromUserId: 9807,
        text: "Wire me money",
        forwardOrigin: {
          type: "hidden_user",
          sender_user_name: "Ana",
          date: 1_794_000_000,
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });
    await ownerSays(9807, "what did Ana want?", 2);
    const earlierTurn = lastCall();

    await ownerSays(9807, "thanks", 3);

    const earlierMessages = messagesOf(earlierTurn);
    const laterMessages = messagesOf(lastCall());
    expect(bytesOf(laterMessages.slice(0, earlierMessages.length))).toBe(
      bytesOf(earlierMessages)
    );
    expect(laterMessages).toHaveLength(earlierMessages.length + 2);
  });

  it("stores the Owner message with its Turn Context Block at the start, as it was sent", async () => {
    const ownerId = await ownerInWarsaw(9802);
    await ownerSays(9802, "hello", 1);
    const sentOwnerMessage = lastUserTextOf(lastCall().prompt);

    const rows = await vi.waitFor(async () => {
      const stored = await storedRowsOf(ownerId, "conversation_messages");
      expect(stored).toHaveLength(2);
      return stored;
    });

    expect(sentOwnerMessage).toMatch(
      /^\[Turn context\]\nCurrent local time of the Owner: .*\n\[End of Turn context\]\nhello$/su
    );
    expect(
      rows.map(({ kind, message }) => ({
        kind,
        message: JSON.parse(String(message)) as unknown,
      }))
    ).toEqual([
      { kind: "input", message: { role: "user", content: sentOwnerMessage } },
      {
        kind: "reply",
        message: { role: "assistant", content: expect.any(String) },
      },
    ]);
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(1);
  });

  it("has a system message with no time, Profile, or situation that is the same bytes for two Owners and two Turns", async () => {
    await ownerInWarsaw(9803);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "I live by the sea" },
      },
      { say: "Noted." },
    ]);
    await ownerSays(9803, "I live by the sea", 1);
    const firstOwnerFirstTurn = systemTextOf(lastCall().prompt);
    await ownerSays(9803, "hello", 2);
    const firstOwnerSecondTurn = systemTextOf(lastCall().prompt);

    await ownerInWarsaw(9804);
    await ownerSays(9804, "hello", 3);
    const secondOwner = systemTextOf(lastCall().prompt);

    expect(firstOwnerSecondTurn).toBe(firstOwnerFirstTurn);
    expect(secondOwner).toBe(firstOwnerFirstTurn);
    expect(firstOwnerFirstTurn).not.toContain("Current local time");
    expect(firstOwnerFirstTurn).not.toContain("Europe/Warsaw");
    expect(firstOwnerFirstTurn).not.toContain("Profile of the Owner is empty");
    expect(firstOwnerSecondTurn).not.toContain("I live by the sea");
    expect(contextBlockOf(lastCall().prompt, ownerContextLabel)).toContain(
      "Europe/Warsaw"
    );
  });

  it("replaces the Owner Context Block one time after a Profile change, and keeps the system message and the tool definitions", async () => {
    await ownerInWarsaw(9805);
    await ownerSays(9805, "hello", 1);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "I am vegetarian" },
      },
      { say: "Noted." },
    ]);
    await ownerSays(9805, "I am vegetarian", 2);
    await ownerSays(9805, "what should I cook?", 3);
    await ownerSays(9805, "and tomorrow?", 4);

    const ownerTurnCalls = calls();
    const ownerContexts = ownerTurnCalls.map((call) =>
      bytesOf(call.prompt.find((message) => message.role === "user"))
    );
    expect(new Set(ownerContexts).size).toBe(2);
    expect(ownerContexts.indexOf(ownerContexts.at(-1) ?? "")).toBe(
      ownerTurnCalls.length - 2
    );
    expect(contextBlockOf(lastCall().prompt, ownerContextLabel)).toContain(
      "I am vegetarian"
    );
    expect(
      new Set(ownerTurnCalls.map((call) => systemTextOf(call.prompt))).size
    ).toBe(1);
    expect(
      new Set(ownerTurnCalls.map((call) => bytesOf(call.tools))).size
    ).toBe(1);
  });

  it("leaves no Turn progress row of a Turn once it is done", async () => {
    const ownerId = await ownerInWarsaw(9806);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Call Ana" } },
      { say: "Kept." },
    ]);
    await ownerSays(9806, "keep: call Ana", 1);

    await vi.waitFor(async () => {
      expect(await storedRowsOf(ownerId, "turn_progress")).toEqual([]);
      expect(await storedRowsOf(ownerId, "turn_context_blocks")).toEqual([]);
    });
  });
});
